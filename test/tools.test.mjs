// Editing tools: catalog, schema + validation, cloud (JSON / multipart, both
// rails), local Desktop runs, auto routing / fallback. Mock HTTP servers stand
// in for the Imference API and Imference Desktop's local API.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { ImferenceClient } from "../dist/client.js";
import { bundledCatalog, loadCatalog, normalizeTools } from "../dist/catalog.js";
import { DesktopClient, discoveryFilePath, userConfigDir } from "../dist/desktop.js";
import {
  buildMcpTool,
  coerceParam,
  isToolMedia,
  listToolsSummary,
  prepareInputs,
  runEditTool,
  summarizeToolMedia,
  validateParams,
} from "../dist/tools.js";

const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// A 1×1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function mockServer() {
  const m = { requests: [], routes: {}, url: "" };
  m.server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const path = new URL(req.url, "http://x").pathname;
      const raw = Buffer.concat(chunks);
      m.requests.push({ method: req.method, path, url: req.url, headers: req.headers, raw, body: raw.toString("latin1") });
      const handler = m.routes[`${req.method} ${path}`] ?? m.routes[path];
      if (!handler) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "no route " + path }));
        return;
      }
      handler(req, res, raw);
    });
  });
  return m;
}

const api = mockServer();
const desk = mockServer();
let tmp;

before(async () => {
  for (const m of [api, desk]) {
    await new Promise((r) => m.server.listen(0, "127.0.0.1", r));
    m.url = `http://127.0.0.1:${m.server.address().port}`;
  }
  tmp = await mkdtemp(join(tmpdir(), "imf-tools-"));
});

after(async () => {
  api.server.close();
  desk.server.close();
  await rm(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  for (const m of [api, desk]) {
    m.requests = [];
    m.routes = {};
  }
});

const json = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};

const catalog = bundledCatalog();
const toolDef = (mcpName) => buildMcpTool(catalog.find((t) => t.mcp_name === mcpName));
// Every shipped tool has a cloud runtime today; a tool without one (e.g. an
// unverified license) is exercised through a copy with the cloud taken away.
const localOnlyEntry = (mcpName) => ({ ...catalog.find((t) => t.mcp_name === mcpName), cloud_available: false });
const localOnlyDef = (mcpName) => buildMcpTool(localOnlyEntry(mcpName));

const desktopUp = () =>
  new DesktopClient({ env: { IMFERENCE_DESKTOP_URL: desk.url, IMFERENCE_DESKTOP_TOKEN: "dtok" } });
// Nothing listens on port 1: connection refused right away.
const desktopDown = () => new DesktopClient({ env: { IMFERENCE_DESKTOP_URL: "http://127.0.0.1:1" } });

function ctx({ desktop = desktopDown(), ...clientCfg } = {}) {
  return {
    client: new ImferenceClient({ baseUrl: api.url, ...clientCfg }),
    desktop,
    poll: { initialMs: 5, maxMs: 20 },
  };
}

const resultJson = (r) => JSON.parse(r.content[0].text);
const errText = (r) => {
  assert.equal(r.isError, true, `expected an error, got ${r.content?.[0]?.text}`);
  return r.content[0].text;
};

async function tempFile(name, bytes) {
  const p = join(tmp, name);
  await writeFile(p, bytes);
  return p;
}

// Routes for one successful cloud run of `toolId`, done on the 2nd status probe.
function cloudRoutes(toolId, data, { rail = "credits" } = {}) {
  const prefix = rail === "x402" ? "/ondemand/tools/" : "/tools/";
  api.routes[`POST ${prefix}${toolId}`] = (_req, res) =>
    json(res, 200, { request_id: "req-1", kind: "tool", tool_id: toolId, credits: 3 });
  let probes = 0;
  api.routes["/ondemand/status"] = (_req, res) => {
    if (++probes < 2) return json(res, 404, { error: "pending" });
    json(res, 200, { data });
  };
  api.routes["/blob/out.png"] = (_req, res) => {
    res.writeHead(200, { "Content-Type": "image/png" }).end(PNG);
  };
}

const doneRow = (extra = {}) => ({
  RequestID: "req-1",
  Kind: "tool",
  URL: `${api.url}/blob/out.png`,
  Format: "png",
  Seed: "",
  Timestamp: "2026-10-13T10:00:00Z",
  Outputs: [{ Name: "image", Type: "image", URL: `${api.url}/blob/out.png`, Format: "png", Width: 1, Height: 1 }],
  ...extra,
});

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

test("bundled catalog loads every available tool with its MCP name", () => {
  const names = catalog.map((t) => t.mcp_name);
  for (const n of ["remove_background", "upscale", "describe_image", "outpaint", "select_object", "video_concat"]) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
  assert.ok(!names.includes("inpaint"), "inpaint is disabled in the engine catalog");
  assert.equal(new Set(names).size, names.length);
});

test("normalizeTools drops hidden and malformed entries, derives mcp_name", () => {
  const tools = normalizeTools([
    { id: "a-tool", name: "A", inputs: { image: { type: "image" } } },
    { id: "hidden", available: false, inputs: { image: { type: "image" } } },
    { id: "no-inputs", inputs: {} },
    { name: "no id" },
    null,
  ]);
  assert.deepEqual(tools.map((t) => t.mcp_name), ["a_tool"]);
  assert.deepEqual(tools[0].params, {});
});

test("loadCatalog prefers the live catalog", async () => {
  api.routes["/api/tools"] = (_req, res) =>
    json(res, 200, {
      version: 1,
      tools: [{ id: "upscale", mcp_name: "upscale", name: "Upscale", description: "x", category: "image",
        inputs: { image: { type: "image", required: true } }, params: {}, outputs: {}, price_credits: 5 }],
    });
  const c = await loadCatalog(new ImferenceClient({ baseUrl: api.url }));
  assert.equal(c.source, "api");
  assert.deepEqual(c.tools.map((t) => t.id), ["upscale"]);
});

test("loadCatalog falls back to the bundled snapshot on error, empty catalog or timeout", async () => {
  const client = new ImferenceClient({ baseUrl: api.url });
  api.routes["/api/tools"] = (_req, res) => json(res, 404, { error: "not found" });
  let c = await loadCatalog(client);
  assert.equal(c.source, "bundled");
  assert.ok(c.tools.length >= 10);
  assert.match(c.fallback_reason, /not found/);

  api.routes["/api/tools"] = (_req, res) => json(res, 200, { tools: [] });
  c = await loadCatalog(client);
  assert.equal(c.source, "bundled");

  api.routes["/api/tools"] = () => {}; // never answers
  const t0 = Date.now();
  c = await loadCatalog(client, { timeoutMs: 150 });
  assert.equal(c.source, "bundled");
  assert.ok(Date.now() - t0 < 2000);

  c = await loadCatalog(client, { bundledOnly: true });
  assert.equal(c.source, "bundled");
});

// ---------------------------------------------------------------------------
// Schema building
// ---------------------------------------------------------------------------

test("buildMcpTool: name, description with price and where it runs, schema", () => {
  const def = toolDef("remove_background");
  assert.equal(def.name, "remove_background");
  assert.equal(def.title, "Remove background");
  assert.match(def.description, /3 credits \(\$0\.003\)/);
  assert.match(def.description, /Imference Desktop/);
  const s = def.inputSchema;
  assert.ok(s.safeParse({ image: "/x.png" }).success);
  assert.ok(s.safeParse({ image: "/x.png", model: "isnet", threshold: 0.5, run_on: "local" }).success);
  assert.equal(s.safeParse({}).success, false); // image required
  assert.equal(s.safeParse({ image: "/x.png", model: "nope" }).success, false);
  assert.equal(s.safeParse({ image: "/x.png", threshold: 2 }).success, false);
  assert.equal(s.safeParse({ image: "/x.png", background: "red" }).success, false);
  assert.equal(s.safeParse({ image: "/x.png", run_on: "gpu" }).success, false);
  assert.equal(s.safeParse({ image: "/x.png", bogus: 1 }).success, false); // strict
});

test("buildMcpTool: numeric enums, points, multiple inputs, generation tools, local-only tools", () => {
  const up = toolDef("upscale").inputSchema;
  assert.ok(up.safeParse({ image: "a.png", scale: 2 }).success);
  assert.equal(up.safeParse({ image: "a.png", scale: 3 }).success, false);

  const seg = toolDef("select_object").inputSchema;
  assert.ok(seg.safeParse({ image: "a.png", points: [{ x: 1, y: 2, label: 1 }] }).success);
  assert.equal(seg.safeParse({ image: "a.png" }).success, false); // points required
  assert.equal(seg.safeParse({ image: "a.png", points: [{ x: 1, y: 2, label: 2 }] }).success, false);

  const cat = toolDef("video_concat").inputSchema;
  assert.ok(cat.safeParse({ videos: ["a.mp4", "b.mp4"] }).success);
  assert.equal(cat.safeParse({ videos: ["a.mp4"] }).success, false); // min_items 2

  const op = toolDef("outpaint");
  assert.match(op.description, /model's generation price/);
  assert.equal(op.inputSchema.safeParse({ image: "a.png", left: 64 }).success, false); // model required
  assert.ok(op.inputSchema.safeParse({ image: "a.png", left: 64, model: "flux" }).success);

  const rf = localOnlyDef("restore_faces");
  assert.match(rf.description, /Local only/);
  assert.equal(rf.inputSchema.safeParse({ image: "a.png", rail: "credits" }).success, false); // no cloud args
});

test("params clashing with an input or a control arg are renamed param_<name>", () => {
  const def = buildMcpTool({
    id: "t", mcp_name: "t", name: "T", description: "", category: "image",
    inputs: { image: { type: "image" } },
    params: { image: { type: "int" }, rail: { type: "string" }, ok: { type: "bool" } },
    outputs: {},
  });
  assert.deepEqual(def.paramArgs, { param_image: "image", param_rail: "rail", ok: "ok" });
  assert.ok(def.inputSchema.safeParse({ image: "x.png", param_image: 3, param_rail: "r" }).success);
});

// ---------------------------------------------------------------------------
// Client-side validation (port of schema.py ParamSpec.coerce)
// ---------------------------------------------------------------------------

test("coerceParam matches the engine's semantics", () => {
  const ok = [
    [{ type: "int", min: 1, max: 10 }, 5, 5],
    [{ type: "int" }, "42", 42],
    [{ type: "int" }, " 7 ", 7],
    [{ type: "int" }, 3.0, 3],
    [{ type: "float", min: 0, max: 1 }, 0.5, 0.5],
    [{ type: "float" }, "0.25", 0.25],
    [{ type: "float" }, 2, 2],
    [{ type: "bool" }, true, true],
    [{ type: "bool" }, "false", false],
    [{ type: "bool" }, "1", true],
    [{ type: "bool" }, 0, false],
    [{ type: "string", max_length: 5 }, "abc", "abc"],
    [{ type: "string", pattern: "^#[0-9a-fA-F]{6}$" }, "#a0B1c2", "#a0B1c2"],
    [{ type: "enum", values: ["png", "webp"] }, "png", "png"],
    [{ type: "enum", values: [2, 4] }, 4, 4],
    [{ type: "enum", values: [2, 4] }, "4", 4],
    [{ type: "points", max_items: 4 }, [{ x: 1, y: 2 }], [{ x: 1, y: 2, label: 1 }]],
    [{ type: "points" }, [[3, 4, 0]], [{ x: 3, y: 4, label: 0 }]],
    [{ type: "points" }, '[{"x": 1, "y": 2, "label": 0}]', [{ x: 1, y: 2, label: 0 }]],
  ];
  for (const [spec, input, expected] of ok) {
    assert.deepEqual(coerceParam("p", spec, input), expected, `${JSON.stringify(spec)} ${JSON.stringify(input)}`);
  }
  const bad = [
    [{ type: "int" }, true, /expected an integer/],
    [{ type: "int" }, 1.5, /expected an integer/],
    [{ type: "int" }, "1.5", /expected an integer/],
    [{ type: "int" }, "", /expected an integer/],
    [{ type: "int", min: 1 }, 0, />= 1/],
    [{ type: "int", max: 10 }, 11, /<= 10/],
    [{ type: "float" }, "abc", /expected a number/],
    [{ type: "float" }, "inf", /finite/],
    [{ type: "float" }, false, /expected a number/],
    [{ type: "float", max: 1 }, 1.5, /<= 1/],
    [{ type: "bool" }, "maybe", /expected a boolean/],
    [{ type: "bool" }, 2, /expected a boolean/],
    [{ type: "string" }, 5, /expected a string/],
    [{ type: "string", max_length: 2 }, "abc", /longer than 2/],
    [{ type: "string", pattern: "^#[0-9a-fA-F]{6}$" }, "red", /does not match/],
    [{ type: "enum", values: ["png"] }, "gif", /expected one of/],
    [{ type: "points", max_items: 1 }, [[1, 1], [2, 2]], /at most 1 points/],
    [{ type: "points" }, [{ x: 1 }], /must be \{x, y, label\}/],
    [{ type: "points" }, [{ x: "a", y: 1 }], /non-numeric/],
    [{ type: "points" }, [{ x: 1, y: 1, label: 3 }], /label must be 0 or 1/],
    [{ type: "points" }, "nope", /JSON list/],
  ];
  for (const [spec, input, re] of bad) {
    assert.throws(
      () => coerceParam("p", spec, input),
      (e) => e.code === "invalid_input" && re.test(e.message) && /param 'p'/.test(e.message),
      `${JSON.stringify(spec)} ${JSON.stringify(input)}`,
    );
  }
});

test("validateParams refuses unknown and missing required params, keeps only given ones", () => {
  const seg = catalog.find((t) => t.id === "segment");
  assert.throws(() => validateParams(seg, {}), /missing required param 'points'/);
  assert.throws(() => validateParams(seg, { points: [[1, 1]], dialte: 2 }), /unknown param\(s\) \["dialte"\]/);
  assert.deepEqual(validateParams(seg, { points: [[1, 1]], dilate: "3" }), {
    points: [{ x: 1, y: 1, label: 1 }],
    dilate: 3,
  });
});

test("prepareInputs checks names, arity, files, data URIs and URL schemes", async () => {
  const rb = catalog.find((t) => t.id === "remove-background");
  const concat = catalog.find((t) => t.id === "video-concat");
  const png = await tempFile("in.png", PNG);
  const code = (re) => (e) => e.code === "invalid_input" && re.test(e.message);

  await assert.rejects(() => prepareInputs(rb, {}), code(/missing required input 'image'/));
  await assert.rejects(() => prepareInputs(rb, { image: png, extra: png }), code(/unknown input/));
  await assert.rejects(() => prepareInputs(rb, { image: [png] }), code(/single file/));
  await assert.rejects(() => prepareInputs(rb, { image: join(tmp, "nope.png") }), code(/no such file/));
  await assert.rejects(() => prepareInputs(rb, { image: "data:nope" }), code(/malformed data/));
  await assert.rejects(() => prepareInputs(rb, { image: "ftp://x/y.png" }), code(/unsupported URL scheme/));
  await assert.rejects(() => prepareInputs(concat, { videos: "a.mp4" }), code(/takes a list/));
  await assert.rejects(() => prepareInputs(concat, { videos: ["https://x/a.mp4"] }), code(/at least 2/));

  const p = await prepareInputs(rb, { image: "in.png" }, tmp); // relative → absolute
  assert.deepEqual(p.byName.image, [{ kind: "path", value: png }]);
  assert.equal(p.hasLocalFiles, true);
  const u = await prepareInputs(rb, { image: "data:image/png;base64,AAAA" });
  assert.equal(u.byName.image[0].kind, "data");
  assert.equal(u.hasLocalFiles, false);

  const small = { ...rb, inputs: { image: { ...rb.inputs.image, max_mb: 0.000001 } } };
  await assert.rejects(() => prepareInputs(small, { image: png }), (e) => e.code === "too_large");
});

test("invalid params fail with invalid_input before any network call", async () => {
  const r = await runEditTool(ctx({ apiKey: "k" }), toolDef("upscale"), {
    image: "https://x/a.png", scale: 3, run_on: "cloud",
  });
  assert.match(errText(r), /invalid_input/);
  assert.match(errText(r), /param 'scale'/);
  assert.equal(api.requests.length, 0);
  assert.equal(desk.requests.length, 0);
});

// ---------------------------------------------------------------------------
// Cloud runs
// ---------------------------------------------------------------------------

test("cloud, credits rail: JSON body for URL inputs, polling, Outputs + preview", async () => {
  cloudRoutes("remove-background", doneRow());
  const r = await runEditTool(ctx({ apiKey: "sk-test" }), toolDef("remove_background"), {
    image: "https://cdn.example/cat.jpg", output: "mask", threshold: "0.5", run_on: "cloud",
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  const post = api.requests.find((q) => q.path === "/tools/remove-background");
  assert.equal(post.headers.authorization, "Bearer sk-test");
  assert.match(post.headers["content-type"], /application\/json/);
  assert.deepEqual(JSON.parse(post.body), {
    inputs: { image: "https://cdn.example/cat.jpg" },
    params: { output: "mask", threshold: 0.5 },
  });
  const out = resultJson(r);
  assert.equal(out.status, "done");
  assert.equal(out.ran, "cloud");
  assert.equal(out.request_id, "req-1");
  assert.equal(out.rail, "credits");
  assert.equal(out.credits, 3);
  assert.deepEqual(out.outputs, [{ name: "image", type: "image", format: "png", url: `${api.url}/blob/out.png`, width: 1, height: 1 }]);
  assert.equal(r.content[1].type, "image");
  assert.equal(r.content[1].mimeType, "image/png");
  assert.equal(r.content[1].data, PNG.toString("base64"));
});

test("cloud: a local file is uploaded as multipart with the exact bytes", async () => {
  const bytes = Buffer.concat([PNG, randomBytes(64)]);
  const file = await tempFile("upload me.png", bytes);
  cloudRoutes("upscale", doneRow());
  const r = await runEditTool(ctx({ apiKey: "k" }), toolDef("upscale"), {
    image: file, scale: 2, run_on: "cloud", include_image: false,
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(r.content.length, 1); // include_image: false
  const post = api.requests.find((q) => q.path === "/tools/upscale");
  assert.match(post.headers["content-type"], /^multipart\/form-data; boundary=/);
  assert.ok(post.raw.includes(bytes), "file bytes not found in the multipart body");
  assert.match(post.body, /name="image"; filename="upload me.png"/);
  assert.match(post.body, /Content-Type: image\/png/);
  assert.match(post.body, /name="params"\r\n\r\n\{"scale":2\}/);
  assert.equal(resultJson(r).uploaded, "local files uploaded (multipart)");
});

test("cloud: multiple inputs mix uploads and URLs", async () => {
  const a = await tempFile("a.mp4", Buffer.from("AAAA-video-bytes"));
  cloudRoutes("video-concat", doneRow({ Outputs: [{ Name: "video", Type: "video", URL: "https://b/v.mp4", Format: "mp4" }] }));
  const r = await runEditTool(ctx({ apiKey: "k" }), toolDef("video_concat"), {
    videos: [a, "https://cdn/b.mp4"], run_on: "cloud",
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  const post = api.requests.find((q) => q.path === "/tools/video-concat");
  assert.match(post.body, /name="videos"; filename="a.mp4"\r\nContent-Type: video\/mp4\r\n\r\nAAAA-video-bytes/);
  assert.match(post.body, /name="videos"\r\n\r\nhttps:\/\/cdn\/b.mp4/);
  assert.equal(r.content.length, 1); // videos are never embedded
});

test("cloud: describe returns Text", async () => {
  cloudRoutes("describe", doneRow({
    URL: "https://b/t.txt", Format: "txt",
    Outputs: [{ Name: "text", Type: "text", URL: "https://b/t.txt", Format: "txt", Text: "A cat on a mat." }],
    Text: "A cat on a mat.",
  }));
  const r = await runEditTool(ctx({ apiKey: "k" }), toolDef("describe_image"), {
    image: "data:image/png;base64," + PNG.toString("base64"), run_on: "cloud",
  });
  const out = resultJson(r);
  assert.equal(out.text, "A cat on a mat.");
  assert.equal(out.outputs[0].text, "A cat on a mat.");
  assert.equal(r.content.length, 1);
  const post = api.requests.find((q) => q.path === "/tools/describe");
  assert.match(JSON.parse(post.body).inputs.image, /^data:image\/png;base64,/);
});

test("cloud: pending after wait_seconds returns the request_id for check_status", async () => {
  api.routes["POST /tools/crop"] = (_req, res) => json(res, 200, { request_id: "slow-1", kind: "tool", credits: 1 });
  api.routes["/ondemand/status"] = (_req, res) => json(res, 404, {});
  const r = await runEditTool(ctx({ apiKey: "k" }), toolDef("crop"), {
    image: "https://x/a.png", width: 10, height: 10, run_on: "cloud", wait_seconds: 0,
  });
  const out = resultJson(r);
  assert.equal(out.status, "pending");
  assert.equal(out.request_id, "slow-1");
  assert.match(out.note, /check_status/);
});

test("cloud: API errors and failed runs surface their code", async () => {
  api.routes["POST /tools/upscale"] = (_req, res) =>
    json(res, 400, { error: "image is 50 MP, the limit is 16 MP", code: "too_large" });
  let r = await runEditTool(ctx({ apiKey: "k" }), toolDef("upscale"), { image: "https://x/a.png", run_on: "cloud" });
  assert.match(errText(r), /HTTP 400, too_large/);
  assert.match(errText(r), /50 MP/);

  api.routes["POST /tools/upscale"] = (_req, res) => json(res, 200, { request_id: "r9", kind: "tool" });
  api.routes["/ondemand/status"] = (_req, res) => json(res, 422, { error: "out of memory", code: "oom" });
  r = await runEditTool(ctx({ apiKey: "k" }), toolDef("upscale"), { image: "https://x/a.png", run_on: "cloud" });
  assert.match(errText(r), /oom/);
  assert.match(errText(r), /out of memory/);
});

test("cloud: no payment method → clear error, no network", async () => {
  const r = await runEditTool(ctx(), toolDef("upscale"), { image: "https://x/a.png", run_on: "cloud" });
  assert.match(errText(r), /No payment method configured/);
  assert.equal(api.requests.length, 0);
});

test("cloud: a local-only tool is refused in the cloud", async () => {
  const png = await tempFile("face.png", PNG);
  const r = await runEditTool(ctx({ apiKey: "k" }), localOnlyDef("restore_faces"), { image: png, run_on: "cloud" });
  assert.match(errText(r), /not_available/);
  assert.equal(api.requests.length, 0);
});

// ---------------------------------------------------------------------------
// x402 rail
// ---------------------------------------------------------------------------

test("x402: tool priced at credits × $0.001, guarded before any network call", async () => {
  const c = ctx({ walletPrivateKey: TEST_PK, x402MaxUsdPerCall: 0.002 });
  const r = await runEditTool(c, toolDef("upscale"), { image: "https://x/a.png", run_on: "cloud" });
  assert.match(errText(r), /per-call cap/);
  assert.match(errText(r), /\$0\.004/); // upscale = 4 credits
  assert.equal(api.requests.length, 0);
});

test("x402: pays the tool price and runs via /ondemand/tools", async () => {
  cloudRoutes("upscale", doneRow(), { rail: "x402" });
  const c = ctx({ walletPrivateKey: TEST_PK });
  const r = await runEditTool(c, toolDef("upscale"), { image: "https://x/a.png", run_on: "cloud", include_image: false });
  assert.equal(r.isError, undefined, r.content[0].text);
  const out = resultJson(r);
  assert.equal(out.rail, "x402");
  assert.ok(api.requests.some((q) => q.path === "/ondemand/tools/upscale" && !q.headers.authorization));
  assert.equal(c.client.sessionSpentUsd, 0.004);
});

test("x402: generation tools are priced at the model's price (default format)", async () => {
  api.routes["/api/models"] = (_req, res) => json(res, 200, { models: [{ model_code: "flux", im_cost: 50 }] });
  api.routes["/api/formats"] = (_req, res) =>
    json(res, 200, { formats: [{ model_code: "flux", format_code: "hd", is_default: true, credit_multiplier: 2 }] });
  const c = ctx({ walletPrivateKey: TEST_PK, x402MaxUsdPerCall: 0.05 });
  const png = await tempFile("src.png", PNG);
  let r = await runEditTool(c, toolDef("vary_image"), { image: png, model: "flux", run_on: "cloud" });
  assert.match(errText(r), /\$0\.100/); // 50 × 2 credits
  assert.ok(!api.requests.some((q) => q.path.startsWith("/ondemand/tools")));

  r = await runEditTool(c, toolDef("vary_image"), { image: png, model: "nope", run_on: "cloud" });
  assert.match(errText(r), /invalid_input.*unknown model 'nope'/);
});

// ---------------------------------------------------------------------------
// Local runs (Imference Desktop)
// ---------------------------------------------------------------------------

function desktopTools(available = { "remove-background": true, upscale: true, describe: true }) {
  desk.routes["GET /v1/tools"] = (_req, res) =>
    json(res, 200, { tools: Object.entries(available).map(([id, local_available]) => ({ id, local_available })) });
}

test("local: runs in Desktop with absolute paths and the token, previews the output file", async () => {
  const src = await tempFile("local in.png", PNG);
  const outPath = await tempFile("local-out.png", PNG);
  desktopTools();
  desk.routes["POST /v1/tools/remove-background"] = (_req, res) =>
    json(res, 200, {
      tool_id: "remove-background",
      outputs: [{ name: "image", type: "image", format: "png", path: outPath }],
      duration_ms: 812,
    });
  const c = { ...ctx({ desktop: desktopUp() }), cwd: tmp };
  const r = await runEditTool(c, toolDef("remove_background"), { image: "local in.png", model: "u2netp" });
  assert.equal(r.isError, undefined, r.content[0].text);
  const post = desk.requests.find((q) => q.method === "POST");
  assert.equal(post.headers.authorization, "Bearer dtok");
  assert.deepEqual(JSON.parse(post.body), { inputs: { image: src }, params: { model: "u2netp" } });
  const out = resultJson(r);
  assert.equal(out.ran, "local");
  assert.equal(out.request_id, "local");
  assert.equal(out.duration_ms, 812);
  assert.equal(out.credits, 0);
  assert.deepEqual(out.outputs, [{ name: "image", type: "image", format: "png", path: outPath }]);
  assert.equal(r.content[1].type, "image");
  assert.equal(r.content[1].data, PNG.toString("base64"));
  assert.equal(api.requests.length, 0); // nothing touched the cloud
});

test("local: describe text, URLs passed as-is", async () => {
  desktopTools();
  desk.routes["POST /v1/tools/describe"] = (_req, res) =>
    json(res, 200, { tool_id: "describe", outputs: [{ name: "text", type: "text", text: "A red car.", path: "/tmp/x.txt" }], duration_ms: 5 });
  const r = await runEditTool(ctx({ desktop: desktopUp() }), toolDef("describe_image"), {
    image: "https://cdn/x.png", run_on: "local",
  });
  assert.equal(resultJson(r).text, "A red car.");
  assert.equal(JSON.parse(desk.requests.at(-1).body).inputs.image, "https://cdn/x.png");
  assert.equal(r.content.length, 1);
});

test("local: Desktop not running → clear error with run_on local", async () => {
  const r = await runEditTool(ctx({ apiKey: "k" }), toolDef("upscale"), { image: "https://x/a.png", run_on: "local" });
  assert.match(errText(r), /Imference Desktop is not running/);
  assert.equal(api.requests.length, 0);
});

test("local: Desktop errors carry their code; run_on local never falls back", async () => {
  desktopTools();
  desk.routes["POST /v1/tools/upscale"] = (_req, res) =>
    json(res, 500, { error: { code: "oom", message: "CUDA out of memory" } });
  const r = await runEditTool(ctx({ apiKey: "k", desktop: desktopUp() }), toolDef("upscale"), {
    image: "https://x/a.png", run_on: "local",
  });
  const text = errText(r);
  assert.match(text, /\(oom\)/);
  assert.match(text, /CUDA out of memory/);
  assert.match(text, /run_on: 'cloud'/);
  assert.equal(api.requests.length, 0);
});

test("auto: local oom is retried in the cloud — and the result says so", async () => {
  desktopTools();
  desk.routes["POST /v1/tools/upscale"] = (_req, res) =>
    json(res, 500, { error: { code: "oom", message: "CUDA out of memory" } });
  cloudRoutes("upscale", doneRow());
  const r = await runEditTool(ctx({ apiKey: "k", desktop: desktopUp() }), toolDef("upscale"), { image: "https://x/a.png" });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.match(r.content[0].text, /ran in the cloud because local failed with oom/);
  const out = resultJson(r);
  assert.equal(out.ran, "cloud");
  assert.equal(out.fallback.code, "oom");
  assert.ok(api.requests.some((q) => q.path === "/tools/upscale"));
});

test("auto: a non-retryable local error is not retried in the cloud", async () => {
  desktopTools();
  desk.routes["POST /v1/tools/upscale"] = (_req, res) =>
    json(res, 400, { error: { code: "invalid_input", message: "not an image" } });
  const r = await runEditTool(ctx({ apiKey: "k", desktop: desktopUp() }), toolDef("upscale"), { image: "https://x/a.png" });
  assert.match(errText(r), /invalid_input/);
  assert.equal(api.requests.length, 0);
});

test("auto: Desktop down or tool unavailable locally → cloud, with the reason", async () => {
  cloudRoutes("upscale", doneRow());
  let r = await runEditTool(ctx({ apiKey: "k" }), toolDef("upscale"), { image: "https://x/a.png", include_image: false });
  let out = resultJson(r);
  assert.equal(out.ran, "cloud");
  assert.match(out.note, /Imference Desktop is not running/);

  desktopTools({ upscale: false });
  cloudRoutes("upscale", doneRow());
  r = await runEditTool(ctx({ apiKey: "k", desktop: desktopUp() }), toolDef("upscale"), { image: "https://x/a.png", include_image: false });
  out = resultJson(r);
  assert.equal(out.ran, "cloud");
  assert.match(out.note, /can't run 'upscale' locally/);
  assert.ok(!desk.requests.some((q) => q.method === "POST"));
});

test("auto: a local-only tool with Desktop down fails with a hint", async () => {
  const png = await tempFile("f.png", PNG);
  const r = await runEditTool(ctx({ apiKey: "k" }), localOnlyDef("restore_faces"), { image: png });
  assert.match(errText(r), /runs only locally/);
  assert.match(errText(r), /Start the Imference Desktop app/);
});

// ---------------------------------------------------------------------------
// Desktop discovery
// ---------------------------------------------------------------------------

test("userConfigDir follows Go's os.UserConfigDir", () => {
  assert.equal(userConfigDir({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32", "C:\\Users\\u"), "C:\\Users\\u\\AppData\\Roaming");
  // join() uses the host's separator, so build expectations with it (the
  // suite also runs on Windows, where these non-native platforms never occur).
  assert.equal(userConfigDir({}, "darwin", "/Users/u"), join("/Users/u", "Library", "Application Support"));
  assert.equal(userConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/u"), "/xdg");
  assert.equal(userConfigDir({ XDG_CONFIG_HOME: "rel" }, "linux", "/home/u"), join("/home/u", ".config"));
  assert.equal(userConfigDir({}, "linux", "/home/u"), join("/home/u", ".config"));
});

test("discovery file: reachable Desktop, stale pid, missing file", async () => {
  const cfg = join(tmp, "xdg");
  const opts = { env: { XDG_CONFIG_HOME: cfg }, platform: "linux" };
  const file = discoveryFilePath(opts);
  assert.equal(file, join(cfg, "imference-desktop-go", "local-api.json"));

  let probe = await new DesktopClient(opts).probe();
  assert.equal(probe.reachable, false);
  assert.match(probe.reason, /no discovery file/);

  await mkdir(dirname(file), { recursive: true });
  const port = Number(new URL(desk.url).port);
  await writeFile(file, JSON.stringify({ port, token: "file-token", pid: process.pid }));
  desktopTools({ upscale: true });
  probe = await new DesktopClient(opts).probe();
  assert.equal(probe.reachable, true);
  assert.equal(probe.endpoint.url, desk.url);
  assert.equal(desk.requests.at(-1).headers.authorization, "Bearer file-token");
  assert.deepEqual(probe.tools, [{ id: "upscale", local_available: true }]);

  await writeFile(file, JSON.stringify({ port, token: "t", pid: 2 ** 22 + 12345 }));
  probe = await new DesktopClient(opts).probe();
  assert.equal(probe.reachable, false);
  assert.match(probe.reason, /stale/);
});

// ---------------------------------------------------------------------------
// check_status / list_tools helpers
// ---------------------------------------------------------------------------

test("summarizeToolMedia reads Outputs/Text; plain generations are not tool media", () => {
  assert.equal(isToolMedia({ RequestID: "g", Kind: "image", URL: "u", Format: "webp", Seed: 1, Timestamp: "t" }), false);
  const row = doneRow({ Text: "hello", Outputs: [{ name: "image", type: "image", url: "https://b/1.png", format: "png" }, { Name: "text", Type: "text", Text: "hello" }] });
  assert.equal(isToolMedia(row), true);
  const s = summarizeToolMedia(row);
  assert.equal(s.request_id, "req-1");
  assert.equal(s.text, "hello");
  assert.deepEqual(s.outputs[0], { name: "image", type: "image", format: "png", url: "https://b/1.png" });
  // No Outputs: the row's URL stands in.
  const bare = summarizeToolMedia({ RequestID: "r", Kind: "tool", URL: "https://b/x.png", Format: "png", Seed: "", Timestamp: "t" });
  assert.deepEqual(bare.outputs, [{ url: "https://b/x.png", format: "png" }]);
});

test("listToolsSummary: prices, cloud/local availability, Desktop reachability", () => {
  const down = listToolsSummary({ source: "bundled", tools: catalog }, { reachable: false, reason: "no file" });
  assert.equal(down.desktop.reachable, false);
  const rb = down.tools.find((t) => t.tool === "remove_background");
  assert.deepEqual(rb.price, { credits: 3, usd: 0.003 });
  assert.equal(rb.cloud, true);
  assert.match(rb.local, /unknown/);
  assert.equal(down.tools.find((t) => t.tool === "outpaint").needs_model, true);
  assert.equal(down.tools.find((t) => t.tool === "restore_faces").cloud, true); // cloud_override
  const lo = listToolsSummary({ source: "bundled", tools: catalog.map((t) => (t.mcp_name === "restore_faces" ? localOnlyEntry("restore_faces") : t)) },
    { reachable: false, reason: "no file" });
  assert.equal(lo.tools.find((t) => t.tool === "restore_faces").cloud, false);

  const up = listToolsSummary(
    { source: "api", tools: catalog },
    { reachable: true, endpoint: { url: "http://127.0.0.1:9" }, tools: [{ id: "remove-background", local_available: true }] },
    "video",
  );
  assert.ok(up.tools.every((t) => t.category === "video"));
  assert.equal(up.tools.find((t) => t.tool === "video_trim").local, false);
  const upAll = listToolsSummary({ source: "api", tools: catalog }, { reachable: true, endpoint: { url: "x" }, tools: [{ id: "remove-background", local_available: true }] });
  assert.equal(upAll.tools.find((t) => t.tool === "remove_background").local, true);
});

// ---------------------------------------------------------------------------
// edit_with_instructions (instruct-edit): references, default model, pricing
// ---------------------------------------------------------------------------

const editTool = catalog.find((t) => t.id === "instruct-edit");
const editDef = (env = {}) => buildMcpTool(editTool, env);
const DATA_PNG = "data:image/png;base64," + PNG.toString("base64");

test("edit_with_instructions: registered with agent guidance; model optional, instruction required", () => {
  assert.equal(editTool.mcp_name, "edit_with_instructions");
  const def = editDef();
  assert.equal(def.name, "edit_with_instructions");
  assert.match(def.description, /replace the background with a beach at sunset/);
  assert.match(def.description, /remove the person on the left/);
  assert.match(def.description, /change the text on the sign to OPEN/);
  assert.match(def.description, /image 2 and image 3/);
  assert.match(def.description, /defaults to 'qwen-image-edit-2511'/);
  assert.match(def.description, /model's generation price/);
  assert.deepEqual(def.paramDefaults, { model: "qwen-image-edit-2511" });
  const s = def.inputSchema;
  assert.ok(s.safeParse({ image: "a.png", instruction: "make it night" }).success);
  assert.ok(s.safeParse({ image: "a.png", instruction: "x", references: ["b.png", "https://c/d.png"] }).success);
  assert.equal(s.safeParse({ image: "a.png" }).success, false); // instruction required
  assert.equal(s.safeParse({ image: "a.png", instruction: "x", references: ["1", "2", "3"] }).success, false);
  assert.equal(s.safeParse({ image: "a.png", instruction: "x", references: [] }).success, false);
  assert.equal(s.safeParse({ image: "a.png", instruction: "x", references: "b.png" }).success, false);
  assert.match(s.shape.model.description, /Default: 'qwen-image-edit-2511'/);

  // IMFERENCE_DEFAULT_EDIT_MODEL overrides; other generation tools keep model required.
  assert.deepEqual(editDef({ IMFERENCE_DEFAULT_EDIT_MODEL: " my-edit " }).paramDefaults, { model: "my-edit" });
  assert.deepEqual(buildMcpTool(catalog.find((t) => t.id === "outpaint"), { IMFERENCE_DEFAULT_EDIT_MODEL: "x" }).paramDefaults, {});
});

test("edit_with_instructions: list_tools shows the default model and which models fit", () => {
  const row = listToolsSummary({ source: "bundled", tools: catalog }, { reachable: false, reason: "x" })
    .tools.find((t) => t.tool === "edit_with_instructions");
  assert.equal(row.default_model, "qwen-image-edit-2511");
  assert.equal(row.needs_model, undefined);
  assert.match(row.model_hint, /edit_model/);
  assert.equal(row.inputs.references, "image[] (optional)");
  const inp = listToolsSummary({ source: "bundled", tools: catalog }, { reachable: false, reason: "x" })
    .tools.find((t) => t.tool === "outpaint");
  assert.equal(inp.needs_model, true);
});

test("edit_with_instructions cloud: references omitted → JSON body with the default model", async () => {
  cloudRoutes("instruct-edit", doneRow());
  const r = await runEditTool(ctx({ apiKey: "k" }), editDef(), {
    image: "https://x/a.png", instruction: "remove the person on the left", run_on: "cloud", include_image: false,
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  const body = JSON.parse(api.requests.find((q) => q.path === "/tools/instruct-edit").body);
  assert.deepEqual(body.inputs, { image: "https://x/a.png" });
  assert.deepEqual(body.params, { model: "qwen-image-edit-2511", instruction: "remove the person on the left" });
});

test("edit_with_instructions cloud: explicit model wins; URL/data references stay JSON lists", async () => {
  cloudRoutes("instruct-edit", doneRow());
  const r = await runEditTool(ctx({ apiKey: "k" }), editDef({ IMFERENCE_DEFAULT_EDIT_MODEL: "env-edit" }), {
    image: "https://x/a.png", references: ["https://x/hat.png", DATA_PNG], instruction: "put the hat from image 2 on him",
    model: "qwen-image-edit-2509", run_on: "cloud", include_image: false,
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  const body = JSON.parse(api.requests.find((q) => q.path === "/tools/instruct-edit").body);
  assert.deepEqual(body.inputs.references, ["https://x/hat.png", DATA_PNG]);
  assert.equal(body.params.model, "qwen-image-edit-2509");
});

test("edit_with_instructions cloud: mixed local files / URL / data URI → repeated multipart fields", async () => {
  const src = await tempFile("edit-src.png", PNG);
  const ref = await tempFile("edit-ref.png", Buffer.concat([PNG, Buffer.from("REF")]));
  cloudRoutes("instruct-edit", doneRow());
  const r = await runEditTool(ctx({ apiKey: "k" }), editDef({ IMFERENCE_DEFAULT_EDIT_MODEL: "env-edit" }), {
    image: src, references: [ref, "https://x/b.png"], instruction: "change the text on the sign to OPEN",
    run_on: "cloud", include_image: false,
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  const post = api.requests.find((q) => q.path === "/tools/instruct-edit");
  assert.match(post.headers["content-type"], /^multipart\/form-data/);
  assert.match(post.body, /name="image"; filename="edit-src.png"/);
  assert.match(post.body, /name="references"; filename="edit-ref.png"\r\nContent-Type: image\/png/);
  assert.match(post.body, /name="references"\r\n\r\nhttps:\/\/x\/b.png/);
  assert.equal(post.body.match(/name="references"/g).length, 2);
  // reference order is preserved: the file (image 2) before the URL (image 3)
  assert.ok(post.body.indexOf('filename="edit-ref.png"') < post.body.indexOf("https://x/b.png"));
  const params = JSON.parse(post.body.match(/name="params"\r\n\r\n(\{.*?\})\r\n/)[1]);
  assert.deepEqual(params, { model: "env-edit", instruction: "change the text on the sign to OPEN" });

  // data URI reference next to a local image: a text field
  api.requests = [];
  cloudRoutes("instruct-edit", doneRow());
  await runEditTool(ctx({ apiKey: "k" }), editDef(), {
    image: src, references: [DATA_PNG], instruction: "x", run_on: "cloud", include_image: false,
  });
  const post2 = api.requests.find((q) => q.path === "/tools/instruct-edit");
  assert.ok(post2.body.includes(`name="references"\r\n\r\n${DATA_PNG}`));
});

test("edit_with_instructions: bad references are refused before any network call", async () => {
  const c = ctx({ apiKey: "k" });
  let r = await runEditTool(c, editDef(), {
    image: "https://x/a.png", references: ["https://x/1.png", "https://x/2.png", "https://x/3.png"], instruction: "x", run_on: "cloud",
  });
  assert.match(errText(r), /at most 2 items/);
  r = await runEditTool(c, editDef(), { image: "https://x/a.png", references: "https://x/1.png", instruction: "x", run_on: "cloud" });
  assert.match(errText(r), /takes a list/);
  r = await runEditTool(c, editDef(), { image: "https://x/a.png", references: [join(tmp, "missing.png")], instruction: "x", run_on: "cloud" });
  assert.match(errText(r), /no such file/);
  r = await runEditTool(c, editDef(), { image: "https://x/a.png", run_on: "cloud" });
  assert.match(errText(r), /missing required param 'instruction'/);
  assert.equal(api.requests.length, 0);
});

test("edit_with_instructions local: Desktop gets absolute reference paths as a list and the default model", async () => {
  const src = await tempFile("loc-src.png", PNG);
  const ref = await tempFile("loc-ref.png", PNG);
  const outPath = await tempFile("loc-out.png", PNG);
  desktopTools({ "instruct-edit": true });
  desk.routes["POST /v1/tools/instruct-edit"] = (_req, res) =>
    json(res, 200, { tool_id: "instruct-edit", outputs: [{ name: "image", type: "image", format: "png", path: outPath }] });
  const c = { ...ctx({ desktop: desktopUp() }), cwd: tmp };
  let r = await runEditTool(c, editDef(), {
    image: "loc-src.png", references: ["loc-ref.png", "https://x/b.png"], instruction: "make it night", seed: 7,
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(resultJson(r).ran, "local");
  assert.deepEqual(JSON.parse(desk.requests.at(-1).body), {
    inputs: { image: src, references: [ref, "https://x/b.png"] },
    params: { model: "qwen-image-edit-2511", instruction: "make it night", seed: 7 },
  });

  // references omitted: no key at all
  r = await runEditTool(c, editDef(), { image: src, instruction: "x", include_image: false });
  assert.deepEqual(JSON.parse(desk.requests.at(-1).body).inputs, { image: src });
  assert.equal(api.requests.length, 0);
});

test("edit_with_instructions x402: priced at the (default) model's price, then paid", async () => {
  api.routes["/api/models"] = (_req, res) =>
    json(res, 200, { models: [
      { model_code: "qwen-image-edit-2511", im_cost: 30, im_engine: "qwenimage-edit" },
      { model_code: "env-edit", im_cost: 80, im_engine: "qwenimage-edit" },
    ] });
  api.routes["/api/formats"] = (_req, res) =>
    json(res, 200, { formats: [{ model_code: "qwen-image-edit-2511", format_code: "std", is_default: true, credit_multiplier: 1 }] });

  // Cap below the env default model's price: refused before paying.
  let c = ctx({ walletPrivateKey: TEST_PK, x402MaxUsdPerCall: 0.05 });
  let r = await runEditTool(c, editDef({ IMFERENCE_DEFAULT_EDIT_MODEL: "env-edit" }), {
    image: "https://x/a.png", instruction: "x", run_on: "cloud",
  });
  assert.match(errText(r), /\$0\.080/);
  assert.ok(!api.requests.some((q) => q.path.startsWith("/ondemand/tools")));

  cloudRoutes("instruct-edit", doneRow(), { rail: "x402" });
  c = ctx({ walletPrivateKey: TEST_PK });
  r = await runEditTool(c, editDef(), { image: "https://x/a.png", instruction: "x", run_on: "cloud", include_image: false });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(resultJson(r).rail, "x402");
  assert.equal(c.client.sessionSpentUsd, 0.03);
  const post = api.requests.find((q) => q.path === "/ondemand/tools/instruct-edit");
  assert.equal(JSON.parse(post.body).params.model, "qwen-image-edit-2511");
});

// ---------------------------------------------------------------------------
// The stdio server end to end
// ---------------------------------------------------------------------------

function rpc(env, messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, "dist/index.js")], {
      env: { ...process.env, IMFERENCE_API_KEY: "", IMFERENCE_WALLET_PRIVATE_KEY: "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    const want = messages.filter((m) => m.id !== undefined).length;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("stdio server timed out: " + out));
    }, 15000);
    child.stdout.on("data", (d) => {
      out += d;
      const lines = out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      if (lines.filter((l) => l.id !== undefined).length >= want) {
        clearTimeout(timer);
        child.kill();
        resolve(lines);
      }
    });
    child.on("error", reject);
    for (const m of messages) child.stdin.write(JSON.stringify(m) + "\n");
  });
}

const INIT = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
];

test("stdio: tools/list exposes the editing tools (bundled catalog)", async () => {
  const lines = await rpc({ IMFERENCE_TOOLS_CATALOG: "bundled" }, [
    ...INIT,
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "upscale", arguments: { image: "https://x/a.png", scale: 3 } } },
  ]);
  assert.equal(lines.find((l) => l.id === 1).result.serverInfo.version, "0.3.0");
  const names = lines.find((l) => l.id === 2).result.tools.map((t) => t.name);
  for (const n of ["generate", "list_tools", "remove_background", "upscale", "describe_image", "outpaint", "edit_with_instructions"]) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
  const call = lines.find((l) => l.id === 3).result;
  assert.equal(call.isError, true);
  assert.match(call.content[0].text, /scale/);
});

test("stdio: the live catalog from GET /api/tools drives the tool list", async () => {
  api.routes["/api/tools"] = (_req, res) =>
    json(res, 200, {
      version: 1,
      tools: [{ id: "remove-background", mcp_name: "remove_background", name: "Remove background", description: "Cut out.",
        category: "image", inputs: { image: { type: "image", required: true } }, params: {}, outputs: {},
        runtimes: { local: ["cpu"], cloud_queue: "tools-gpu" }, price_credits: 7, cloud_available: true }],
    });
  const lines = await rpc({ IMFERENCE_BASE_URL: api.url, IMFERENCE_DESKTOP_URL: "http://127.0.0.1:1" }, [
    ...INIT,
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_tools", arguments: {} } },
  ]);
  const tools = lines.find((l) => l.id === 2).result.tools;
  assert.ok(tools.some((t) => t.name === "remove_background" && /7 credits/.test(t.description)));
  assert.ok(!tools.some((t) => t.name === "upscale"));
  const listed = JSON.parse(lines.find((l) => l.id === 3).result.content[0].text);
  assert.equal(listed.catalog_source, "api");
  assert.equal(listed.desktop.reachable, false);
  assert.deepEqual(listed.tools[0].price, { credits: 7, usd: 0.007 });
});

test("stdio: list_models / get_model flag instruction-edit models", async () => {
  api.routes["/api/models"] = (_req, res) =>
    json(res, 200, { models: [
      { model_code: "qwen-image-edit-2511", name: "Qwen Edit", im_cost: 30, im_engine: "qwenimage-edit", model_type: "image" },
      { model_code: "flux", name: "Flux", im_cost: 50, im_engine: "flux", model_type: "image" },
    ] });
  api.routes["/api/formats"] = (_req, res) => json(res, 200, { formats: [] });
  api.routes["/api/tools"] = (_req, res) => json(res, 404, {});
  const lines = await rpc({ IMFERENCE_BASE_URL: api.url, IMFERENCE_TOOLS_CATALOG: "bundled" }, [
    ...INIT,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_models", arguments: { kind: "image-edit" } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_model", arguments: { model: "qwen-image-edit-2511" } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_models", arguments: {} } },
  ]);
  const listed = JSON.parse(lines.find((l) => l.id === 2).result.content[0].text);
  assert.deepEqual(listed.models.map((m) => m.model_code), ["qwen-image-edit-2511"]);
  const edit = listed.models[0];
  assert.equal(edit.edit_model, true);
  assert.equal(edit.kind, "image-edit");
  assert.equal(edit.engine, "qwenimage-edit");
  // The default listing is the generation models: no edit model in it.
  const generation = JSON.parse(lines.find((l) => l.id === 4).result.content[0].text);
  assert.deepEqual(generation.models.map((m) => m.model_code), ["flux"]);
  assert.equal(generation.models[0].edit_model, undefined);
  const got = JSON.parse(lines.find((l) => l.id === 3).result.content[0].text);
  assert.equal(got.edit_model.tool, "edit_with_instructions");
});
