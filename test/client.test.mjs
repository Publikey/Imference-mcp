// Unit tests for the Imference HTTP client against a local mock server.
// Run with: npm test  (builds, then `node --test test/`)

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import {
  ImferenceClient,
  ImferenceError,
  computeCreditCost,
  creditsToAtomicUsdc,
  resolveFormat,
  usdToAtomic,
  isVideoModel,
} from "../dist/client.js";

// Well-known Hardhat test key #0 — public, never fund it.
const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

let server;
let baseUrl;
let requests; // log of {method, path, headers, body}
let routes; // path → handler(req, res, body)

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const path = new URL(req.url, "http://x").pathname;
      requests.push({ method: req.method, path, headers: req.headers, body });
      const handler = routes[path];
      if (!handler) {
        res.writeHead(500).end(JSON.stringify({ error: "no route" }));
        return;
      }
      handler(req, res, body);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

beforeEach(() => {
  requests = [];
  routes = {};
});

const json = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};

const makeClient = (extra = {}) => new ImferenceClient({ baseUrl, ...extra });

// ---------------------------------------------------------------------------
// Catalog + parsing
// ---------------------------------------------------------------------------

test("listModels parses the models envelope", async () => {
  routes["/api/models"] = (_req, res) =>
    json(res, 200, { models: [{ model_code: "flux", im_cost: 50, steps_default: 20 }] });
  const models = await makeClient().listModels();
  assert.equal(models.length, 1);
  assert.equal(models[0].model_code, "flux");
});

test("GET retries on 5xx then succeeds", async () => {
  let calls = 0;
  routes["/api/models"] = (_req, res) => {
    calls++;
    if (calls < 3) return json(res, 502, { error: "bad gateway" });
    json(res, 200, { models: [] });
  };
  const models = await makeClient().listModels();
  assert.deepEqual(models, []);
  assert.equal(calls, 3);
});

test("isVideoModel matches wan22 engine and wan-video queues", () => {
  assert.equal(isVideoModel({ im_engine: "wan22" }), true);
  assert.equal(isVideoModel({ queue: "wan-video.normal" }), true);
  assert.equal(isVideoModel({ im_engine: "sdxl", queue: "sdxl-multimodel.normal" }), false);
});

// ---------------------------------------------------------------------------
// Status mapping (404 pending / 422 failed / 200 done)
// ---------------------------------------------------------------------------

test("status maps HTTP codes to states", async () => {
  const client = makeClient();

  routes["/ondemand/status"] = (_req, res) => json(res, 404, { error: "not ready" });
  assert.deepEqual(await client.status("id1"), { state: "pending" });

  routes["/ondemand/status"] = (_req, res) => json(res, 422, { error: "generation failed: oom" });
  const failed = await client.status("id1");
  assert.equal(failed.state, "failed");
  assert.match(failed.error, /oom/);

  routes["/ondemand/status"] = (_req, res) =>
    json(res, 200, { data: { RequestID: "id1", Kind: "image", URL: "https://blob/x.webp", Format: "webp", Seed: 7, Timestamp: "t" } });
  const done = await client.status("id1");
  assert.equal(done.state, "done");
  assert.equal(done.media.URL, "https://blob/x.webp");
});

test("status polls the unauthenticated ondemand endpoint", async () => {
  routes["/ondemand/status"] = (_req, res) => json(res, 404, {});
  await makeClient().status("abc");
  assert.equal(requests[0].path, "/ondemand/status");
  assert.equal(requests[0].headers.authorization, undefined);
});

// ---------------------------------------------------------------------------
// Credits rail
// ---------------------------------------------------------------------------

test("generate posts the payload with the Bearer key", async () => {
  routes["/generate"] = (_req, res) => json(res, 200, { request_id: "r1", kind: "image" });
  const client = makeClient({ apiKey: "sk-test" });
  const out = await client.generate({ model: "flux", prompt: "a cat" });
  assert.deepEqual(out, { request_id: "r1", kind: "image" });
  assert.equal(requests[0].headers.authorization, "Bearer sk-test");
  assert.deepEqual(JSON.parse(requests[0].body), { model: "flux", prompt: "a cat" });
});

test("generate without an API key fails before any network call", async () => {
  await assert.rejects(
    () => makeClient().generate({ model: "flux", prompt: "x" }),
    (e) => e instanceof ImferenceError && /IMFERENCE_API_KEY/.test(e.message),
  );
  assert.equal(requests.length, 0);
});

test("API error bodies surface in the error message", async () => {
  routes["/generate"] = (_req, res) => json(res, 400, { error: "not enough credits" });
  await assert.rejects(
    () => makeClient({ apiKey: "k" }).generate({ model: "flux", prompt: "x" }),
    /not enough credits/,
  );
});

test("allMedia returns [] on 204", async () => {
  routes["/media/all"] = (_req, res) => res.writeHead(204).end();
  assert.deepEqual(await makeClient({ apiKey: "k" }).allMedia(), []);
});

test("balance parses credits", async () => {
  routes["/credits/balance"] = (_req, res) => json(res, 200, { credits: 1234 });
  assert.equal(await makeClient({ apiKey: "k" }).balance(), 1234);
});

// ---------------------------------------------------------------------------
// x402 spending guards (must trip BEFORE any signing or network call)
// ---------------------------------------------------------------------------

test("per-call cap blocks an over-priced generation with no network call", async () => {
  const client = makeClient({ walletPrivateKey: TEST_PK, x402MaxUsdPerCall: 0.2 });
  await assert.rejects(
    // 500 credits = $0.50 > $0.20 cap
    () => client.generateX402({ model: "wan", prompt: "x" }, 500),
    (e) => e instanceof ImferenceError && /per-call cap/.test(e.message),
  );
  assert.equal(requests.length, 0);
});

test("session cap accumulates across payments", async () => {
  routes["/ondemand/generate"] = (_req, res) => json(res, 200, { request_id: "r", kind: "image" });
  const client = makeClient({ walletPrivateKey: TEST_PK, x402SessionMaxUsd: 0.08 });
  // Two $0.05 generations: first passes, second must trip the $0.08 session cap.
  await client.generateX402({ model: "flux", prompt: "x" }, 50);
  assert.equal(client.sessionSpentUsd, 0.05);
  await assert.rejects(
    () => client.generateX402({ model: "flux", prompt: "y" }, 50),
    (e) => e instanceof ImferenceError && /session/.test(e.message),
  );
});

// ---------------------------------------------------------------------------
// Pricing — must mirror the API's creditCost (pricing.go), which prices the
// 402 challenge: a mismatch means the wallet signs for less than the challenge
// and every x402 generation fails.
// ---------------------------------------------------------------------------

test("computeCreditCost applies format, duration and batch multipliers, ceiled once", () => {
  const video = { im_cost: 10, duration_s_default: 5, duration_s_min: 1, duration_s_max: 15 };
  const hd = { model_code: "m", format_code: "hd", credit_multiplier: 2, is_default: false };

  assert.equal(computeCreditCost(video, undefined, {}), 10); // bare catalog price
  assert.equal(computeCreditCost(video, hd, {}), 20); // HD bills ×2
  assert.equal(computeCreditCost(video, hd, { duration_s: 10 }), 40); // 10s on 5s default ×2
  assert.equal(computeCreditCost(video, undefined, { duration_s: 60 }), 30); // clamped to max 15s → ×3
  assert.equal(computeCreditCost(video, undefined, { batch_nbr: 3 }), 30); // every image billed
  assert.equal(computeCreditCost({ im_cost: 3 }, undefined, { duration_s: 8 }), 3); // no duration knob → untouched
  assert.equal(computeCreditCost({ im_cost: 0 }, hd, { batch_nbr: 4 }), 0); // free stays free
  assert.equal(computeCreditCost({ im_cost: 1 }, { credit_multiplier: 0.1 }, {}), 1); // floor of 1
});

test("resolveFormat picks the named format, else the model's default", () => {
  const formats = [
    { model_code: "m", format_code: "square", is_default: true },
    { model_code: "m", format_code: "landscape-wide", is_default: false, credit_multiplier: 2 },
  ];
  assert.equal(resolveFormat(formats, "Landscape-Wide").format_code, "landscape-wide");
  assert.equal(resolveFormat(formats, undefined).format_code, "square");
  assert.equal(resolveFormat(formats, "nope").format_code, "square"); // unknown → default (the MCP refuses it upstream)
  assert.equal(resolveFormat([], "square"), undefined);
});

test("top-up bounds convert to the right atomic amounts", () => {
  assert.equal(creditsToAtomicUsdc(100), 100_000n); // $0.10
  assert.equal(creditsToAtomicUsdc(1_000_000), 1_000_000_000n); // $1,000
  assert.equal(usdToAtomic(10), 10_000_000n);
});

test("wallet address derives from the private key, key never required for reads", () => {
  const client = makeClient({ walletPrivateKey: TEST_PK });
  assert.equal(client.walletAddress, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  assert.equal(makeClient().walletAddress, undefined);
});

test("malformed private key is rejected at construction", () => {
  assert.throws(() => makeClient({ walletPrivateKey: "0x123" }), /64-hex-char/);
});
