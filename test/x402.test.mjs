// x402 v2 payment flow of the client against a mock paid API: what it signs,
// what it refuses, and what it does with the answer (the client side of the
// x402-conformance checks C1-C3).
// Run with: npm test

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { ImferenceClient, ImferenceError } from "../dist/client.js";

// Well-known Hardhat test key #0 — public, never fund it.
const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const PAYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

let server;
let baseUrl;
let calls; // {path, payment: "none"|"v1"|"v2", signature?}
let behaviour; // how the mock answers a paid retry

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));

const offer = (over = {}) => ({
  scheme: "exact",
  network: "eip155:8453",
  amount: "50000",
  asset: USDC_BASE,
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: { name: "USD Coin", version: "2", paymentFlow: "upfront" },
  ...over,
});

before(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const path = new URL(req.url, "http://x").pathname;
      const sig = req.headers["payment-signature"];
      const v1 = req.headers["x-payment"];
      calls.push({ path, payment: sig ? "v2" : v1 ? "v1" : "none", signature: sig ? unb64(sig) : undefined });
      if (!sig && !v1) {
        // Both challenges, like the API: v2 in the header, v1 as the body.
        res.writeHead(402, {
          "Content-Type": "application/json",
          "PAYMENT-REQUIRED": b64({
            x402Version: 2,
            error: "Payment required",
            resource: { url: baseUrl + path, description: "test", mimeType: "application/json" },
            accepts: behaviour.accepts,
          }),
        });
        res.end(JSON.stringify({
          x402Version: 1,
          error: "X-PAYMENT header is required",
          accepts: behaviour.accepts.map((a) => ({ ...a, network: "base", maxAmountRequired: a.amount })),
        }));
        return;
      }
      if (behaviour.settle) {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "PAYMENT-RESPONSE": b64({ success: true, transaction: "0xabc", network: "eip155:8453", payer: PAYER }),
        });
        res.end(JSON.stringify(behaviour.body ?? { request_id: "r1", kind: "image" }));
        return;
      }
      // Settlement refused: the API answers 402 again.
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ x402Version: 2, error: "invalid_transaction_state" }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

beforeEach(() => {
  calls = [];
  behaviour = { accepts: [offer()], settle: true };
});

const makeClient = (extra = {}) => new ImferenceClient({ baseUrl, walletPrivateKey: TEST_PK, ...extra });

test("pays the v2 challenge with PAYMENT-SIGNATURE, never X-PAYMENT (C3)", async () => {
  const out = await makeClient().generateX402({ model: "flux", prompt: "x" }, 50);
  assert.equal(out.request_id, "r1");
  assert.deepEqual(calls.map((c) => c.payment), ["none", "v2"]);
  const sig = calls[1].signature;
  assert.equal(sig.x402Version, 2);
  assert.deepEqual(sig.accepted, offer()); // the offer echoed unchanged
  assert.equal(sig.payload.authorization.from.toLowerCase(), PAYER.toLowerCase());
  assert.equal(sig.payload.authorization.to.toLowerCase(), PAY_TO.toLowerCase());
  assert.equal(sig.payload.authorization.value, "50000");
  assert.deepEqual(out.payment, { success: true, transaction: "0xabc", network: "eip155:8453", payer: PAYER });
});

test("a credits top-up above the SDK's $1 default cap is paid", async () => {
  behaviour.accepts = [offer({ amount: "500000000" })]; // $500
  behaviour.body = { api_key: "k", credits_added: 500000 };
  const out = await makeClient().addCreditsX402(500000);
  assert.equal(out.credits_added, 500000);
  assert.equal(calls[1].payment, "v2");
});

test("an offer above the authorized price is refused, nothing signed (C2)", async () => {
  behaviour.accepts = [offer({ amount: "200000" })]; // $0.20 for a $0.05 run (+ $0.01 headroom)
  await assert.rejects(
    () => makeClient().generateX402({ model: "flux", prompt: "x" }, 50),
    (e) => e instanceof ImferenceError && /Payment not signed/.test(e.message),
  );
  assert.deepEqual(calls.map((c) => c.payment), ["none"]);
});

test("offers off Base mainnet USDC are refused, nothing signed (C2)", async () => {
  for (const bad of [
    offer({ network: "eip155:84532", asset: USDC_SEPOLIA }), // testnet
    offer({ network: "eip155:1" }), // another chain
    offer({ asset: "0x2222222222222222222222222222222222222222" }), // another token
    offer({ scheme: "upto" }),
  ]) {
    calls = [];
    behaviour.accepts = [bad];
    await assert.rejects(
      () => makeClient().generateX402({ model: "flux", prompt: "x" }, 50),
      (e) => e instanceof ImferenceError && /Payment not signed/.test(e.message),
    );
    assert.deepEqual(calls.map((c) => c.payment), ["none"], JSON.stringify(bad));
  }
});

test("among several offers, pays the one it may sign (C2)", async () => {
  behaviour.accepts = [offer({ network: "eip155:84532", asset: USDC_SEPOLIA }), offer()];
  await makeClient().generateX402({ model: "flux", prompt: "x" }, 50);
  assert.equal(calls[1].signature.accepted.network, "eip155:8453");
});

test("a refused settlement is an error, never a result, and is not counted as spent (C1)", async () => {
  behaviour.settle = false;
  const client = makeClient();
  await assert.rejects(
    () => client.generateX402({ model: "flux", prompt: "x" }, 50),
    (e) => e instanceof ImferenceError && e.status === 402,
  );
  assert.equal(client.sessionSpentUsd, 0);
});
