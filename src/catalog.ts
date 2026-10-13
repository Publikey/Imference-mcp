/**
 * Editing-tool catalog: the public manifests published by the engine
 * (`python -m imference_engine.tools export`) and served by GET /api/tools.
 *
 * A snapshot ships with the package (tools-catalog.json next to this file);
 * at startup the server tries the live catalog with a short timeout and falls
 * back to the snapshot, so it always starts — offline included.
 */

import { readFileSync } from "node:fs";

import type { ImferenceClient } from "./client.js";

export interface InputSpec {
  type: "image" | "mask" | "video" | string;
  required?: boolean;
  multiple?: boolean;
  min_items?: number;
  max_items?: number;
  max_megapixels?: number;
  max_mb?: number;
  max_seconds?: number;
  description?: string;
}

export interface ParamSpec {
  type: "int" | "float" | "bool" | "string" | "enum" | "points" | string;
  default?: unknown;
  required?: boolean;
  description?: string;
  min?: number;
  max?: number;
  values?: (string | number | boolean)[];
  max_length?: number;
  pattern?: string;
  max_items?: number;
}

export interface CatalogTool {
  id: string;
  version?: string;
  name: string;
  description: string;
  /** image | video | generation */
  category: string;
  mcp_name: string;
  inputs: Record<string, InputSpec>;
  params: Record<string, ParamSpec>;
  outputs: Record<string, { type: string; format?: string; description?: string }>;
  runtimes?: {
    local?: string[];
    cloud_queue?: string | null;
    slow_on_cpu?: boolean;
    min_ram_gb?: number;
    min_vram_gb?: number;
    needs_engine?: boolean;
  };
  cost?: { credits?: number };
  /** API catalog only: price per run in credits / USD; "model" on generation tools. */
  price_credits?: number;
  price_usd?: number;
  price?: string;
  available?: boolean;
  cloud_available?: boolean;
  weights_mb?: number;
  [key: string]: unknown;
}

export interface Catalog {
  source: "api" | "bundled";
  tools: CatalogTool[];
  /** Why the live catalog was not used (bundled source only). */
  fallback_reason?: string;
}

/** True for tools priced at the selected generation model's price. */
export function isGenerationTool(t: CatalogTool): boolean {
  return t.category === "generation" || t.price === "model" || !!t.runtimes?.needs_engine;
}

/** Price per cloud run in credits (generation tools: 0 = the model's price). */
export function toolPriceCredits(t: CatalogTool): number {
  if (typeof t.price_credits === "number") return t.price_credits;
  return t.cost?.credits ?? 0;
}

export function isCloudAvailable(t: CatalogTool): boolean {
  if (typeof t.cloud_available === "boolean") return t.cloud_available;
  return !!t.runtimes?.cloud_queue;
}

/**
 * Normalize one raw catalog entry; returns undefined when it is unusable
 * (hidden, malformed) so one bad entry never breaks the server.
 */
export function normalizeTool(raw: unknown): CatalogTool | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as Partial<CatalogTool>;
  if (typeof t.id !== "string" || !t.id) return undefined;
  if (t.available === false) return undefined;
  if (!t.inputs || typeof t.inputs !== "object" || !Object.keys(t.inputs).length) return undefined;
  const mcpName = typeof t.mcp_name === "string" && t.mcp_name ? t.mcp_name : t.id.replace(/-/g, "_");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(mcpName)) return undefined;
  return {
    ...(t as CatalogTool),
    mcp_name: mcpName,
    name: typeof t.name === "string" && t.name ? t.name : t.id,
    description: typeof t.description === "string" ? t.description : "",
    category: typeof t.category === "string" ? t.category : "image",
    params: t.params && typeof t.params === "object" ? t.params : {},
    outputs: t.outputs && typeof t.outputs === "object" ? t.outputs : {},
  };
}

export function normalizeTools(raw: unknown[]): CatalogTool[] {
  const out: CatalogTool[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const t = normalizeTool(r);
    if (!t || seen.has(t.mcp_name)) continue;
    seen.add(t.mcp_name);
    out.push(t);
  }
  return out;
}

/** The snapshot bundled with the package (dist/tools-catalog.json). */
export function bundledCatalog(): CatalogTool[] {
  const raw = JSON.parse(readFileSync(new URL("./tools-catalog.json", import.meta.url), "utf8")) as {
    tools?: unknown[];
  };
  return normalizeTools(raw.tools ?? []);
}

/**
 * Live catalog from GET /api/tools when it answers within timeoutMs with at
 * least one usable tool; the bundled snapshot otherwise.
 * IMFERENCE_TOOLS_CATALOG=bundled skips the network call.
 */
export async function loadCatalog(
  client: ImferenceClient,
  opts: { timeoutMs?: number; bundledOnly?: boolean } = {},
): Promise<Catalog> {
  if (opts.bundledOnly) {
    return { source: "bundled", tools: bundledCatalog(), fallback_reason: "live catalog disabled" };
  }
  try {
    const live = await client.listTools(opts.timeoutMs ?? 2500);
    const tools = normalizeTools(live.tools);
    if (tools.length) return { source: "api", tools };
    return { source: "bundled", tools: bundledCatalog(), fallback_reason: "live catalog was empty" };
  } catch (e) {
    return {
      source: "bundled",
      tools: bundledCatalog(),
      fallback_reason: e instanceof Error ? e.message : String(e),
    };
  }
}
