/**
 * Editing tools: one MCP tool per catalog entry (remove_background, upscale,
 * describe_image, inpaint, ...), each runnable locally in Imference Desktop
 * (free, files stay on the machine) or in the cloud (credits or x402).
 *
 * Everything here is transport-agnostic so it can be unit tested: index.ts
 * only registers what buildMcpTool() describes and calls runEditTool().
 */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { z, type ZodTypeAny } from "zod";

import {
  computeCreditCost,
  ImferenceError,
  resolveFormat,
  type ImferenceClient,
  type MediaRow,
  type PaymentReceipt,
  type StatusResult,
  type ToolRequestBody,
} from "./client.js";
import {
  isCloudAvailable,
  isGenerationTool,
  toolPriceCredits,
  type Catalog,
  type CatalogTool,
  type InputSpec,
  type ParamSpec,
} from "./catalog.js";
import {
  DESKTOP_NOT_RUNNING,
  DesktopError,
  type DesktopClient,
  type DesktopEndpoint,
  type DesktopProbe,
  type DesktopRunResult,
} from "./desktop.js";
import {
  fail,
  MIME_BY_FORMAT,
  mimeForPath,
  ok,
  previewFromFile,
  previewFromUrl,
  ToolRunError,
  type ContentBlock,
  type ToolResult,
} from "./results.js";

// ---------------------------------------------------------------------------
// Rails + polling (shared with generate / check_status)
// ---------------------------------------------------------------------------

export type Rail = "credits" | "x402";

/**
 * Picks the payment rail: explicit request wins, otherwise credits (API key)
 * when configured, otherwise x402 (wallet).
 */
export function resolveRail(client: ImferenceClient, requested?: Rail): Rail {
  if (requested === "credits") {
    if (!client.hasApiKey) {
      throw new ImferenceError(
        "rail 'credits' requested but IMFERENCE_API_KEY is not set. " +
          (client.hasWallet
            ? "Either set an API key, use rail 'x402', or buy a key with buy_credits_with_wallet."
            : "Set IMFERENCE_API_KEY (get one at https://imference.com)."),
      );
    }
    return "credits";
  }
  if (requested === "x402") {
    if (!client.hasWallet) {
      throw new ImferenceError(
        "rail 'x402' requested but IMFERENCE_WALLET_PRIVATE_KEY is not set. " +
          "The x402 rail needs an EVM wallet holding USDC on Base.",
      );
    }
    return "x402";
  }
  if (client.hasApiKey) return "credits";
  if (client.hasWallet) return "x402";
  throw new ImferenceError(
    "No payment method configured. Set IMFERENCE_API_KEY (credits rail) and/or " +
      "IMFERENCE_WALLET_PRIVATE_KEY (x402 rail, USDC on Base).",
  );
}

export interface PollOptions {
  /** First delay between probes (default 2000 ms), ×1.5 each round. */
  initialMs?: number;
  /** Delay ceiling (default 10 000 ms). */
  maxMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll GET /ondemand/status with backoff until the request is done or failed,
 * or waitMs elapses (then the last state, "pending", is returned).
 */
export async function waitForStatus(
  client: ImferenceClient,
  requestId: string,
  waitMs: number,
  opts: PollOptions = {},
): Promise<StatusResult> {
  const deadline = Date.now() + waitMs;
  let delay = opts.initialMs ?? 2000;
  const maxDelay = opts.maxMs ?? 10_000;
  while (Date.now() < deadline) {
    await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
    delay = Math.min(delay * 1.5, maxDelay);
    const status = await client.status(requestId);
    if (status.state !== "pending") return status;
  }
  return { state: "pending" };
}

// ---------------------------------------------------------------------------
// Param validation — a port of imference_engine.tools.schema.ParamSpec.coerce
// (same rules on every surface: the engine, the API, Desktop and here).
// ---------------------------------------------------------------------------

function invalid(msg: string): ToolRunError {
  return new ToolRunError("invalid_input", msg);
}

function repr(v: unknown): string {
  return typeof v === "string" ? `'${v}'` : JSON.stringify(v) ?? String(v);
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "list";
  return typeof v;
}

/** Python re.fullmatch → JS. Undefined when the pattern isn't valid JS regex syntax. */
function fullMatchRegex(pattern: string): RegExp | undefined {
  // An already anchored pattern is kept as is (it reads better in the JSON schema).
  const src = /^\^.*(?<!\\)\$$/s.test(pattern) && !pattern.includes("|") ? pattern : `^(?:${pattern})$`;
  try {
    return new RegExp(src, "u");
  } catch {
    try {
      return new RegExp(src);
    } catch {
      return undefined;
    }
  }
}

const INT_RE = /^[+-]?\d+$/;
const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const TRUE_WORDS = ["true", "1", "yes", "on"];
const FALSE_WORDS = ["false", "0", "no", "off"];

function checkRange(spec: ParamSpec, value: number, bad: (m: string) => ToolRunError): void {
  if (spec.min != null && value < spec.min) throw bad(`must be >= ${spec.min}`);
  if (spec.max != null && value > spec.max) throw bad(`must be <= ${spec.max}`);
}

/** Validate + normalize one param value. Throws ToolRunError(invalid_input). */
export function coerceParam(name: string, spec: ParamSpec, value: unknown): unknown {
  const bad = (msg: string) => invalid(`param '${name}': ${msg}`);
  switch (spec.type) {
    case "int": {
      let v = value;
      if (typeof v === "boolean") throw bad("expected an integer");
      if (typeof v === "string") {
        const s = v.trim();
        if (!INT_RE.test(s)) throw bad(`expected an integer, got ${repr(value)}`);
        v = Number(s);
      }
      if (typeof v !== "number" || !Number.isFinite(v)) throw bad(`expected an integer, got ${typeName(value)}`);
      if (!Number.isInteger(v)) throw bad(`expected an integer, got ${repr(value)}`);
      checkRange(spec, v, bad);
      return v;
    }
    case "float": {
      let v = value;
      if (typeof v === "boolean") throw bad("expected a number");
      if (typeof v === "string") {
        const s = v.trim();
        const word = s.toLowerCase().replace(/^[+-]/, "");
        if (["inf", "infinity", "nan"].includes(word)) throw bad("expected a finite number");
        if (!FLOAT_RE.test(s)) throw bad(`expected a number, got ${repr(value)}`);
        v = Number(s);
      }
      if (typeof v !== "number") throw bad(`expected a number, got ${typeName(value)}`);
      if (!Number.isFinite(v)) throw bad("expected a finite number");
      checkRange(spec, v, bad);
      return v;
    }
    case "bool": {
      if (typeof value === "boolean") return value;
      if (typeof value === "string") {
        const s = value.trim().toLowerCase();
        if (TRUE_WORDS.includes(s)) return true;
        if (FALSE_WORDS.includes(s)) return false;
      }
      if (value === 0 || value === 1) return value === 1;
      throw bad(`expected a boolean, got ${repr(value)}`);
    }
    case "string": {
      if (typeof value !== "string") throw bad(`expected a string, got ${typeName(value)}`);
      if (spec.max_length != null && [...value].length > spec.max_length) {
        throw bad(`longer than ${spec.max_length} characters`);
      }
      if (spec.pattern) {
        const re = fullMatchRegex(spec.pattern);
        if (re && !re.test(value)) throw bad(`does not match ${spec.pattern}`);
      }
      return value;
    }
    case "enum": {
      const values = spec.values ?? [];
      if (values.some((v) => v === value)) return value;
      // Accept "2" for an int enum (query strings, CLI).
      for (const v of values) if (String(v) === String(value)) return v;
      throw bad(`expected one of ${JSON.stringify(values)}, got ${repr(value)}`);
    }
    case "points": {
      let v = value;
      if (typeof v === "string") {
        try {
          v = JSON.parse(v);
        } catch {
          throw bad("expected a JSON list of {x, y, label}");
        }
      }
      if (!Array.isArray(v)) throw bad("expected a list of {x, y, label}");
      if (spec.max_items != null && v.length > spec.max_items) throw bad(`at most ${spec.max_items} points`);
      return v.map((p0, i) => {
        let p: unknown = p0;
        if (Array.isArray(p) && (p.length === 2 || p.length === 3)) {
          p = { x: p[0], y: p[1], label: p.length === 3 ? p[2] : 1 };
        }
        if (!p || typeof p !== "object" || Array.isArray(p) || !("x" in p) || !("y" in p)) {
          throw bad(`point ${i} must be {x, y, label}`);
        }
        const o = p as { x: unknown; y: unknown; label?: unknown };
        const num = (u: unknown) =>
          typeof u === "number" ? u : typeof u === "string" && FLOAT_RE.test(u.trim()) ? Number(u) : NaN;
        const x = num(o.x);
        const y = num(o.y);
        const labelRaw = o.label === undefined ? 1 : typeof o.label === "boolean" ? Number(o.label) : num(o.label);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(labelRaw)) {
          throw bad(`point ${i} has non-numeric coordinates`);
        }
        const label = Math.trunc(labelRaw);
        if (label !== 0 && label !== 1) throw bad(`point ${i} label must be 0 or 1`);
        return { x, y, label };
      });
    }
    default:
      throw bad(`unknown param type '${spec.type}'`);
  }
}

/**
 * Validate a request's params against the manifest. Unknown keys and missing
 * required params are refused (a typo must not silently run with the
 * default). Returns only the params given (normalized); the engine fills
 * defaults itself.
 */
export function validateParams(tool: CatalogTool, params: Record<string, unknown>): Record<string, unknown> {
  const unknown = Object.keys(params)
    .filter((k) => !(k in tool.params))
    .sort();
  if (unknown.length) {
    throw invalid(
      `unknown param(s) ${JSON.stringify(unknown)} for tool '${tool.id}'; allowed: ` +
        JSON.stringify(Object.keys(tool.params).sort()),
    );
  }
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(tool.params)) {
    const v = params[name];
    if (v !== undefined && v !== null) out[name] = coerceParam(name, spec, v);
    else if (spec.required) throw invalid(`missing required param '${name}'`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inputs: local file path, https URL or data: URI
// ---------------------------------------------------------------------------

export type InputKind = "url" | "data" | "path";

export function classifyInput(v: string): InputKind {
  if (/^https?:\/\//i.test(v)) return "url";
  if (/^data:/i.test(v)) return "data";
  return "path";
}

const DATA_URI_RE = /^data:[\w.+-]+\/[\w.+-]+(;[\w.+-]+=[^;,]*)*(;base64)?,/i;

export interface PreparedInput {
  kind: InputKind;
  /** URL / data URI as given, or the absolute local path. */
  value: string;
}

export interface PreparedInputs {
  byName: Record<string, PreparedInput[]>;
  multiple: Record<string, boolean>;
  hasLocalFiles: boolean;
}

/** `~/x`, `file:///x` and relative paths → absolute path. */
export function resolveLocalPath(v: string, cwd: string = process.cwd()): string {
  if (/^file:\/\//i.test(v)) return fileURLToPath(v);
  if (v === "~") return homedir();
  if (v.startsWith("~/") || v.startsWith("~\\")) return resolvePath(homedir(), v.slice(2));
  return isAbsolute(v) ? v : resolvePath(cwd, v);
}

/**
 * Check input names / arity like the engine's validate_input_names, then each
 * value: URLs must be http(s), data URIs well formed, local files must exist
 * (and respect max_mb). Runs before any network call or payment.
 */
export async function prepareInputs(
  tool: CatalogTool,
  given: Record<string, unknown>,
  cwd?: string,
): Promise<PreparedInputs> {
  const unknown = Object.keys(given)
    .filter((k) => !(k in tool.inputs))
    .sort();
  if (unknown.length) {
    throw invalid(
      `unknown input(s) ${JSON.stringify(unknown)} for tool '${tool.id}'; expected: ` +
        JSON.stringify(Object.keys(tool.inputs).sort()),
    );
  }
  const out: PreparedInputs = { byName: {}, multiple: {}, hasLocalFiles: false };
  for (const [name, spec] of Object.entries(tool.inputs)) {
    const val = given[name];
    const required = spec.required !== false;
    if (val === undefined || val === null || val === "" || (Array.isArray(val) && !val.length)) {
      if (required) throw invalid(`missing required input '${name}'`);
      continue;
    }
    let list: unknown[];
    if (spec.multiple) {
      if (!Array.isArray(val)) throw invalid(`input '${name}' takes a list`);
      const min = spec.min_items ?? 1;
      if (val.length < min) throw invalid(`input '${name}' needs at least ${min} items`);
      if (spec.max_items != null && val.length > spec.max_items) {
        throw invalid(`input '${name}' takes at most ${spec.max_items} items`);
      }
      list = val;
    } else {
      if (Array.isArray(val)) throw invalid(`input '${name}' takes a single file`);
      list = [val];
    }
    const prepared: PreparedInput[] = [];
    for (const item of list) {
      if (typeof item !== "string" || !item.trim()) {
        throw invalid(`input '${name}' must be a file path, an https URL or a data: URI`);
      }
      const s = item.trim();
      const kind = classifyInput(s);
      if (kind === "data") {
        if (!DATA_URI_RE.test(s)) throw invalid(`input '${name}': malformed data: URI (expected data:<mime>;base64,...)`);
        prepared.push({ kind, value: s });
      } else if (kind === "url") {
        try {
          new URL(s);
        } catch {
          throw invalid(`input '${name}': invalid URL '${s}'`);
        }
        prepared.push({ kind, value: s });
      } else {
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^file:\/\//i.test(s)) {
          throw invalid(`input '${name}': unsupported URL scheme in '${s}' (use https, data: or a local path)`);
        }
        const path = resolveLocalPath(s, cwd);
        let size: number;
        try {
          const st = await stat(path);
          if (!st.isFile()) throw new Error("not a file");
          size = st.size;
        } catch {
          throw invalid(`input '${name}': no such file '${path}'`);
        }
        if (spec.max_mb != null && size > spec.max_mb * 1024 * 1024) {
          throw new ToolRunError(
            "too_large",
            `input '${name}': '${path}' is ${(size / 1024 / 1024).toFixed(1)} MB, the limit is ${spec.max_mb} MB`,
          );
        }
        prepared.push({ kind, value: path });
        out.hasLocalFiles = true;
      }
    }
    out.byName[name] = prepared;
    out.multiple[name] = !!spec.multiple;
  }
  return out;
}

/** Inputs as the wire wants them (`{name: value | [values]}`). */
export function inputsPayload(p: PreparedInputs): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, items] of Object.entries(p.byName)) {
    out[name] = p.multiple[name] ? items.map((i) => i.value) : items[0].value;
  }
  return out;
}

/**
 * Cloud request body: JSON when every input is a URL / data URI, multipart
 * (local files uploaded as parts, URLs as text fields, params as JSON) as soon
 * as one input is a local file.
 */
export async function buildCloudBody(
  p: PreparedInputs,
  params: Record<string, unknown>,
): Promise<ToolRequestBody> {
  if (!p.hasLocalFiles) return { kind: "json", inputs: inputsPayload(p), params };
  const form = new FormData();
  for (const [name, items] of Object.entries(p.byName)) {
    for (const item of items) {
      if (item.kind === "path") {
        const bytes = await readFile(item.value);
        form.append(name, new Blob([bytes], { type: mimeForPath(item.value) }), basename(item.value));
      } else {
        form.append(name, item.value);
      }
    }
  }
  form.append("params", JSON.stringify(params));
  return { kind: "multipart", form };
}

// ---------------------------------------------------------------------------
// MCP tool definition (schema + description) from a manifest
// ---------------------------------------------------------------------------

/** Control arguments every editing tool takes; params never shadow them. */
export const CONTROL_ARGS = ["run_on", "wait_seconds", "include_image", "rail"] as const;

export type RunOn = "auto" | "local" | "cloud";

export interface McpToolDef {
  name: string;
  title: string;
  description: string;
  /** Strict object: unknown arguments are refused. */
  inputSchema: z.ZodObject<Record<string, ZodTypeAny>>;
  /** MCP argument name → manifest param name (differs only on a name clash). */
  paramArgs: Record<string, string>;
  tool: CatalogTool;
}

function fmtDefault(v: unknown): string {
  return typeof v === "string" ? `'${v}'` : JSON.stringify(v);
}

function paramDescription(name: string, spec: ParamSpec): string {
  const parts: string[] = [];
  if (spec.description) parts.push(spec.description.replace(/\.?$/, "."));
  if (spec.type === "points" && !spec.description) {
    parts.push("List of clicks {x, y, label} in image pixels; label 1 = include, 0 = exclude.");
  }
  if (spec.required) parts.push("Required.");
  else if (spec.default !== undefined && spec.default !== null) parts.push(`Default: ${fmtDefault(spec.default)}.`);
  else parts.push("Optional.");
  return parts.join(" ") || name;
}

function literalUnion(values: (string | number | boolean)[]): ZodTypeAny {
  const lits = values.map((v) => z.literal(v));
  if (lits.length === 1) return lits[0];
  return z.union(lits as unknown as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
}

export function paramSchema(name: string, spec: ParamSpec): ZodTypeAny {
  let s: ZodTypeAny;
  switch (spec.type) {
    case "int": {
      let n = z.number().int();
      if (spec.min != null) n = n.min(spec.min);
      if (spec.max != null) n = n.max(spec.max);
      s = n;
      break;
    }
    case "float": {
      let n = z.number();
      if (spec.min != null) n = n.min(spec.min);
      if (spec.max != null) n = n.max(spec.max);
      s = n;
      break;
    }
    case "bool":
      s = z.boolean();
      break;
    case "string": {
      let t = z.string();
      if (spec.max_length != null) t = t.max(spec.max_length);
      const re = spec.pattern ? fullMatchRegex(spec.pattern) : undefined;
      if (re) t = t.regex(re, `must match ${spec.pattern}`);
      s = t;
      break;
    }
    case "enum": {
      const values = spec.values ?? [];
      s = values.length && values.every((v) => typeof v === "string")
        ? z.enum(values as [string, ...string[]])
        : literalUnion(values);
      break;
    }
    case "points": {
      let a = z.array(
        z.object({
          x: z.number().describe("Pixel column in the input image"),
          y: z.number().describe("Pixel row in the input image"),
          label: z.union([z.literal(0), z.literal(1)]).optional().describe("1 = include (default), 0 = exclude"),
        }),
      );
      if (spec.max_items != null) a = a.max(spec.max_items);
      s = a;
      break;
    }
    default:
      s = z.unknown();
  }
  s = s.describe(paramDescription(name, spec));
  return spec.required ? s : s.optional();
}

function inputDescription(name: string, spec: InputSpec): string {
  const what = spec.type === "mask" ? "mask image (white = selected)" : spec.type;
  const parts = [
    `${spec.description || name} (${what}).`,
    spec.multiple
      ? "A list of local file paths, https URLs or data: URIs, in order."
      : "A local file path, an https URL or a data: URI.",
  ];
  const limits: string[] = [];
  if (spec.max_mb != null) limits.push(`≤ ${spec.max_mb} MB`);
  if (spec.max_megapixels != null) limits.push(`≤ ${spec.max_megapixels} MP`);
  if (spec.max_seconds != null) limits.push(`≤ ${spec.max_seconds} s`);
  if (spec.multiple) {
    limits.push(`${spec.min_items ?? 1}${spec.max_items != null ? `–${spec.max_items}` : "+"} items`);
  }
  if (limits.length) parts.push(`Limits: ${limits.join(", ")}.`);
  return parts.join(" ");
}

export function inputSchemaFor(name: string, spec: InputSpec): ZodTypeAny {
  let s: ZodTypeAny;
  if (spec.multiple) {
    let a = z.array(z.string()).min(spec.min_items ?? 1);
    if (spec.max_items != null) a = a.max(spec.max_items);
    s = a;
  } else {
    s = z.string().min(1);
  }
  s = s.describe(inputDescription(name, spec));
  return spec.required === false ? s.optional() : s;
}

export function priceText(tool: CatalogTool): string {
  if (isGenerationTool(tool)) {
    return "Price in the cloud: the selected model's generation price (see get_model / list_models).";
  }
  const c = toolPriceCredits(tool);
  return `Price in the cloud: ${c} credit${c === 1 ? "" : "s"} ($${(c * 0.001).toFixed(3)}) per run.`;
}

export function whereText(tool: CatalogTool): string {
  const local = tool.runtimes?.local ?? [];
  const cloud = isCloudAvailable(tool);
  const localPart = local.length
    ? `locally in Imference Desktop (free; ${local.join("/")}${tool.runtimes?.slow_on_cpu ? ", slow on CPU" : ""})`
    : "";
  if (isGenerationTool(tool)) {
    return (
      "Needs a generation model: pass `model` (a model_code from list_models that accepts an image input). " +
      "Runs in the cloud on that model's workers" +
      (local.length ? "; locally only when Imference Desktop reports it available (GPU)." : ".")
    );
  }
  if (cloud && localPart) {
    return `Runs ${localPart} or in the cloud; run_on 'auto' (default) uses Desktop when it is running, else the cloud.`;
  }
  if (localPart) return `Local only: runs ${localPart} — not offered in the cloud. Needs Imference Desktop running.`;
  return "Runs in the cloud.";
}

function outputsText(tool: CatalogTool): string {
  const outs = Object.entries(tool.outputs).map(
    ([n, o]) => `${n} (${o.type}${o.format ? `, ${o.format}` : ""})`,
  );
  return outs.length ? `Returns: ${outs.join(", ")}.` : "";
}

/** Build the MCP tool (name, description, zod schema) of one catalog entry. */
export function buildMcpTool(tool: CatalogTool): McpToolDef {
  const shape: Record<string, ZodTypeAny> = {};
  for (const [name, spec] of Object.entries(tool.inputs)) shape[name] = inputSchemaFor(name, spec);

  const paramArgs: Record<string, string> = {};
  for (const [name, spec] of Object.entries(tool.params)) {
    let arg = name;
    if (arg in shape || (CONTROL_ARGS as readonly string[]).includes(arg)) arg = `param_${name}`;
    paramArgs[arg] = name;
    shape[arg] = paramSchema(name, spec);
  }

  const cloud = isCloudAvailable(tool);
  shape.run_on = z
    .enum(["auto", "local", "cloud"])
    .optional()
    .describe(
      "Where to run: 'local' = Imference Desktop on this computer (free, files stay local), " +
        "'cloud' = Imference API (paid), 'auto' (default) = local when Desktop is running and can " +
        "run this tool, else cloud. With 'auto', a local out-of-memory / unsupported-hardware " +
        "failure is retried in the cloud and the result says so.",
    );
  if (cloud) {
    shape.wait_seconds = z
      .number()
      .int()
      .min(0)
      .max(600)
      .optional()
      .describe(
        "Cloud runs: how long to wait for the result before returning the request_id for " +
          "check_status (default 120, 0 = return immediately). Local runs always wait.",
      );
    shape.rail = z
      .enum(["credits", "x402"])
      .optional()
      .describe(
        "Cloud payment rail: 'credits' (API key balance) or 'x402' (per-run USDC payment on Base). " +
          "Default: credits if an API key is configured, else x402.",
      );
  }
  shape.include_image = z
    .boolean()
    .optional()
    .describe("Embed image outputs in the result so you can see them (default true; ≤ 3 MB, never videos).");

  const description = [
    tool.description,
    whereText(tool),
    priceText(tool) + (tool.runtimes?.local?.length ? " Free when run locally." : ""),
    outputsText(tool),
  ]
    .filter(Boolean)
    .join(" ");

  return {
    name: tool.mcp_name,
    title: tool.name,
    description,
    inputSchema: z.object(shape).strict(),
    paramArgs,
    tool,
  };
}

// ---------------------------------------------------------------------------
// Running a tool
// ---------------------------------------------------------------------------

export interface ToolsContext {
  client: ImferenceClient;
  desktop: DesktopClient;
  poll?: PollOptions;
  /** Base for relative input paths (default process.cwd()). */
  cwd?: string;
}

/** Local error codes after which the cloud can still succeed (docs/tools.md). */
export const CLOUD_RETRYABLE_CODES = new Set(["oom", "unsupported_runtime", "weights_missing", "desktop_unavailable"]);

const MAX_PREVIEWS = 4;

export interface OutputSummary {
  name?: string;
  type?: string;
  format?: string;
  url?: string;
  path?: string;
  text?: string;
  width?: number;
  height?: number;
}

function pick(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** One output row of a status `Outputs` list (Go-cased or snake-cased keys). */
export function normalizeOutput(o: Record<string, unknown>): OutputSummary {
  return compact({
    name: str(pick(o, "Name", "name")),
    type: str(pick(o, "Type", "type", "Kind", "kind")),
    format: str(pick(o, "Format", "format")),
    url: str(pick(o, "URL", "Url", "url")),
    text: str(pick(o, "Text", "text")),
    width: num(pick(o, "Width", "width")),
    height: num(pick(o, "Height", "height")),
  });
}

export function isToolMedia(m: MediaRow): boolean {
  return m.Kind === "tool" || Array.isArray(m.Outputs) || typeof m.Text === "string";
}

/** Summary of a finished cloud tool request from its /status row. */
export function summarizeToolMedia(m: MediaRow): {
  request_id: string;
  kind: string;
  tool_id?: string;
  outputs: OutputSummary[];
  text?: string;
  duration_ms?: number;
  timestamp?: string;
} {
  let outputs = Array.isArray(m.Outputs)
    ? m.Outputs.filter((o) => o && typeof o === "object").map(normalizeOutput)
    : [];
  if (!outputs.length && m.URL) {
    outputs = [compact({ url: m.URL, format: m.Format || undefined, type: m.Kind !== "tool" ? m.Kind : undefined })];
  }
  const texts = outputs.map((o) => o.text).filter((t): t is string => !!t);
  return compact({
    request_id: m.RequestID,
    kind: m.Kind,
    tool_id: str(pick(m, "ToolID", "tool_id")),
    outputs,
    text: typeof m.Text === "string" && m.Text ? m.Text : texts.length ? texts.join("\n\n") : undefined,
    duration_ms: num(pick(m, "DurationMs", "duration_ms")),
    timestamp: m.Timestamp || undefined,
  });
}

function isImageOutput(o: OutputSummary): boolean {
  if (o.type === "video" || o.type === "text" || o.type === "json") return false;
  if (o.type === "image" || o.type === "mask") return true;
  const fmt = (o.format ?? (o.url ?? o.path ?? "").split("?")[0].split(".").pop() ?? "").toLowerCase();
  return fmt in MIME_BY_FORMAT;
}

export async function previewOutputs(client: ImferenceClient, outputs: OutputSummary[]): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  for (const o of outputs.filter(isImageOutput).slice(0, MAX_PREVIEWS)) {
    if (o.path) blocks.push(...(await previewFromFile(o.path, o.format)));
    else if (o.url) blocks.push(...(await previewFromUrl(client, o.url, o.format)));
  }
  return blocks;
}

interface Routing {
  ran: "local" | "cloud";
  /** Why it ran where it did (auto routing, fallback). */
  note?: string;
  fallback?: { from: "local"; code: string; message: string };
}

/** Split MCP arguments into control args, inputs and manifest params. */
export function splitArgs(def: McpToolDef, args: Record<string, unknown>) {
  const control: { run_on?: RunOn; wait_seconds?: number; include_image?: boolean; rail?: Rail } = {};
  const inputs: Record<string, unknown> = {};
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    if ((CONTROL_ARGS as readonly string[]).includes(k)) (control as Record<string, unknown>)[k] = v;
    else if (k in def.tool.inputs) inputs[k] = v;
    else if (k in def.paramArgs) params[def.paramArgs[k]] = v;
    else params[k] = v; // unknown → refused by validateParams
  }
  if (control.run_on !== undefined && !["auto", "local", "cloud"].includes(control.run_on)) {
    throw invalid(`run_on must be 'auto', 'local' or 'cloud', got ${repr(control.run_on)}`);
  }
  return { control, inputs, params };
}

/** The MCP handler of one editing tool. Never throws: errors become fail(). */
export async function runEditTool(
  ctx: ToolsContext,
  def: McpToolDef,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = def.tool;
  try {
    const { control, inputs, params: rawParams } = splitArgs(def, args);
    const params = validateParams(tool, rawParams);
    const prepared = await prepareInputs(tool, inputs, ctx.cwd);
    const runOn: RunOn = control.run_on ?? "auto";
    const cloudOk = isCloudAvailable(tool);

    if (runOn === "cloud") {
      if (!cloudOk) {
        throw new ToolRunError(
          "not_available",
          `'${tool.mcp_name}' is not offered in the cloud — run it locally with Imference Desktop (run_on: 'local').`,
        );
      }
      return await runCloud(ctx, tool, prepared, params, control, { ran: "cloud" });
    }

    const probe = await ctx.desktop.probe();
    const localTool = probe.reachable ? probe.tools.find((t) => t.id === tool.id) : undefined;
    const localOk = probe.reachable && localTool?.local_available === true;

    if (!localOk) {
      const why = !probe.reachable
        ? `Imference Desktop is not running (${probe.reason})`
        : localTool
          ? `Imference Desktop can't run '${tool.id}' locally on this computer`
          : `this Imference Desktop version doesn't have '${tool.id}'`;
      if (runOn === "local") {
        throw new ToolRunError(
          "desktop_unavailable",
          !probe.reachable ? `${DESKTOP_NOT_RUNNING} Details: ${probe.reason}.` : `${why}. Use run_on: 'cloud'.`,
        );
      }
      if (!cloudOk) {
        throw new ToolRunError(
          "not_available",
          `'${tool.mcp_name}' runs only locally and ${why}. ` +
            (!probe.reachable ? "Start the Imference Desktop app on this computer and retry." : ""),
        );
      }
      return await runCloud(ctx, tool, prepared, params, control, {
        ran: "cloud",
        note: `run_on 'auto': ran in the cloud because ${why}.`,
      });
    }

    const endpoint = (probe as Extract<DesktopProbe, { reachable: true }>).endpoint;
    try {
      return await runLocal(ctx, tool, endpoint, prepared, params, control);
    } catch (e) {
      if (!(e instanceof DesktopError)) throw e;
      const canFallBack =
        runOn === "auto" && cloudOk && CLOUD_RETRYABLE_CODES.has(e.code) && (ctx.client.hasApiKey || ctx.client.hasWallet);
      if (!canFallBack) {
        const hint =
          runOn === "local" && cloudOk && CLOUD_RETRYABLE_CODES.has(e.code)
            ? " The cloud can run it: retry with run_on: 'cloud'."
            : "";
        throw new ToolRunError(e.code, `local run failed: ${e.message}${hint}`);
      }
      return await runCloud(ctx, tool, prepared, params, control, {
        ran: "cloud",
        note: `ran in the cloud because local failed with ${e.code}: ${e.message}`,
        fallback: { from: "local", code: e.code, message: e.message },
      });
    }
  } catch (e) {
    return fail(e);
  }
}

async function runLocal(
  ctx: ToolsContext,
  tool: CatalogTool,
  endpoint: DesktopEndpoint,
  prepared: PreparedInputs,
  params: Record<string, unknown>,
  control: { include_image?: boolean },
): Promise<ToolResult> {
  const res: DesktopRunResult = await ctx.desktop.run(endpoint, tool.id, inputsPayload(prepared), params);
  const outputs: OutputSummary[] = res.outputs.map((o) =>
    compact({
      name: str(o.name),
      type: str(o.type),
      format: str(o.format),
      path: str(o.path),
      text: str(o.text),
      width: num(o.width),
      height: num(o.height),
    }),
  );
  const texts = outputs.map((o) => o.text).filter((t): t is string => !!t);
  const preview = control.include_image === false ? [] : await previewOutputs(ctx.client, outputs);
  return ok(
    compact({
      status: "done",
      tool: tool.mcp_name,
      tool_id: tool.id,
      ran: "local",
      request_id: "local",
      outputs,
      text: texts.length ? texts.join("\n\n") : undefined,
      duration_ms: num(res.duration_ms),
      credits: 0,
      params: Object.keys(params).length ? params : undefined,
    }),
    preview,
  );
}

/** Price of one cloud run on the x402 rail, in credits — before any payment. */
async function x402Price(ctx: ToolsContext, tool: CatalogTool, params: Record<string, unknown>): Promise<number> {
  if (!isGenerationTool(tool)) return toolPriceCredits(tool);
  const code = params.model;
  if (typeof code !== "string" || !code) throw invalid("param 'model' is required (a model_code from list_models)");
  const [models, formats] = await Promise.all([ctx.client.listModels(), ctx.client.listFormats()]);
  const model = models.find((m) => m.model_code === code);
  if (!model) throw invalid(`unknown model '${code}' — use list_models to see valid model codes`);
  const format = resolveFormat(formats.filter((f) => f.model_code === code), undefined);
  return computeCreditCost(model, format, {});
}

async function runCloud(
  ctx: ToolsContext,
  tool: CatalogTool,
  prepared: PreparedInputs,
  params: Record<string, unknown>,
  control: { wait_seconds?: number; include_image?: boolean; rail?: Rail },
  routing: Routing,
): Promise<ToolResult> {
  let rail: Rail;
  try {
    rail = resolveRail(ctx.client, control.rail);
  } catch (e) {
    if (routing.fallback || control.rail) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new ToolRunError(
      "no_payment_method",
      `${msg} Or run it locally for free with Imference Desktop` +
        (tool.runtimes?.local?.length ? " (start the app, then retry)." : "."),
    );
  }

  let request_id: string;
  let credits: number | undefined;
  let payment: PaymentReceipt | undefined;
  if (rail === "x402") {
    // Price first (an unknown model fails here), then build the body and pay.
    const price = await x402Price(ctx, tool, params);
    const body = await buildCloudBody(prepared, params);
    const res = await ctx.client.submitToolX402(tool.id, body, price);
    request_id = res.request_id;
    credits = res.credits ?? price;
    payment = res.payment;
  } else {
    const body = await buildCloudBody(prepared, params);
    const res = await ctx.client.submitTool(tool.id, body);
    request_id = res.request_id;
    credits = res.credits;
  }

  const base = {
    tool: tool.mcp_name,
    tool_id: tool.id,
    ran: routing.ran,
    note: routing.note,
    fallback: routing.fallback,
    rail,
    credits,
    payment,
    uploaded: prepared.hasLocalFiles ? "local files uploaded (multipart)" : undefined,
  };

  const waitMs = (control.wait_seconds ?? 120) * 1000;
  const status = await waitForStatus(ctx.client, request_id, waitMs, ctx.poll);
  if (status.state === "failed") {
    const prefix = routing.note ? `${routing.note}; then the cloud run failed: ` : "";
    throw new ImferenceError(prefix + status.error, 422, status.code);
  }
  if (status.state === "done") {
    const summary = summarizeToolMedia(status.media);
    const preview = control.include_image === false ? [] : await previewOutputs(ctx.client, summary.outputs);
    return ok(compact({ status: "done", ...base, ...summary, request_id }), preview);
  }
  return ok(
    compact({
      status: "pending",
      request_id,
      ...base,
      note:
        (routing.note ? `${routing.note} ` : "") +
        `Still running after ${waitMs / 1000}s. Poll it with the check_status tool (request_id: ${request_id}).`,
    }),
  );
}

// ---------------------------------------------------------------------------
// list_tools
// ---------------------------------------------------------------------------

export function listToolsSummary(catalog: Catalog, probe: DesktopProbe, kind?: string) {
  const local = probe.reachable ? new Map(probe.tools.map((t) => [t.id, t])) : undefined;
  const tools = catalog.tools
    .filter((t) => !kind || kind === "all" || t.category === kind)
    .map((t) => {
      const gen = isGenerationTool(t);
      const c = toolPriceCredits(t);
      return compact({
        tool: t.mcp_name,
        id: t.id,
        name: t.name,
        category: t.category,
        description: t.description,
        price: gen
          ? "the selected model's generation price"
          : { credits: c, usd: Number((c * 0.001).toFixed(3)) },
        cloud: isCloudAvailable(t),
        local: local
          ? local.get(t.id)?.local_available === true
          : (t.runtimes?.local?.length ?? 0) > 0
            ? "unknown (Imference Desktop not running)"
            : false,
        local_runtimes: t.runtimes?.local?.length ? t.runtimes.local : undefined,
        slow_on_cpu: t.runtimes?.slow_on_cpu || undefined,
        weights_mb: t.weights_mb || undefined,
        inputs: Object.fromEntries(
          Object.entries(t.inputs).map(([n, s]) => [n, `${s.type}${s.multiple ? "[]" : ""}${s.required === false ? " (optional)" : ""}`]),
        ),
        params: Object.keys(t.params),
        needs_model: gen || undefined,
      });
    });
  return {
    count: tools.length,
    catalog_source: catalog.source,
    desktop: probe.reachable
      ? { reachable: true, url: probe.endpoint.url }
      : { reachable: false, reason: probe.reason, note: "Start Imference Desktop to run tools locally for free." },
    tools,
    usage:
      "Call a tool by its `tool` name. Inputs take a local file path, an https URL or a data: URI. " +
      "run_on: 'auto' (default) runs locally in Imference Desktop when it can, else in the cloud " +
      "(credits or x402). 1 credit = $0.001.",
  };
}
