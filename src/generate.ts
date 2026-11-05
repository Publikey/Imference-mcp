/**
 * generate's local route: Imference Desktop generates on this computer's GPU
 * (free, the image lands in its gallery) through its local API.
 *
 * run_on:
 *   cloud → the cloud (credits or x402), as before.
 *   local → Desktop only; any problem is an error, never a paid run.
 *   auto  → Desktop when it can run THIS request (engine installed, model on
 *           disk, no cloud-only option), else the cloud with a note saying
 *           why. Once a local run has started, a local failure is an error
 *           that suggests run_on: 'cloud': never a silent paid retry.
 */

import type { GeneratePayload } from "./client.js";
import {
  DESKTOP_NOT_RUNNING,
  DesktopError,
  type DesktopClient,
  type DesktopEndpoint,
  type DesktopGenerateBody,
  type DesktopGenerationInfo,
} from "./desktop.js";
import { ok, ToolRunError, type ToolResult } from "./results.js";
import { previewOutputs, resolveLocalPath, type OutputSummary, type RunOn, type ToolsContext } from "./tools.js";

export type GeneratePlan =
  | { where: "local"; endpoint: DesktopEndpoint; body: DesktopGenerateBody }
  | { where: "cloud"; note?: string };

/** Options the local engine doesn't take: a reason, or undefined. */
export function cloudOnlyReason(p: Partial<GeneratePayload>): string | undefined {
  if (p.loras?.length) return "LoRAs are cloud-only in generate";
  if ((p.batch_nbr ?? 1) > 1) return "batch_nbr > 1 is cloud-only";
  if (p.num_frames || p.fps || p.duration_s) return "num_frames / fps / duration_s are cloud-only";
  return undefined;
}

/** img_url is an http(s) URL (the cloud only fetches those). */
export function isRemoteUrl(v: string): boolean {
  return /^https?:\/\//i.test(v.trim());
}

/** The body Desktop gets: the model's defaults fill what's omitted. */
export function localBody(p: Partial<GeneratePayload>, model: string | undefined, cwd?: string): DesktopGenerateBody {
  const body: DesktopGenerateBody = { prompt: p.prompt ?? "" };
  if (model) body.model = model;
  if (p.negative_prompt) body.negative_prompt = p.negative_prompt;
  if (p.format_code) body.format_code = p.format_code;
  if (p.steps) body.steps = p.steps;
  if (p.guidance_scale) body.guidance_scale = p.guidance_scale;
  if (p.seed !== undefined) body.seed = p.seed;
  if (p.scheduler) body.scheduler = p.scheduler;
  if (p.img_url) {
    const v = p.img_url.trim();
    // A relative path is relative to the MCP server, not to Desktop.
    body.source_image = isRemoteUrl(v) || v.startsWith("data:") ? v : resolveLocalPath(v, cwd);
  }
  return body;
}

function localNotPossible(info: DesktopGenerationInfo, model: string | undefined): string | undefined {
  if (info.reason === "engine_not_installed") return "the local engine isn't installed in Imference Desktop";
  if (!model) {
    if (!info.model) return "no local model is selected in Imference Desktop";
    if (info.reason === "edit_model_loaded") return "Imference Desktop has an instruction-edit model loaded";
    return undefined;
  }
  const m = info.models.find((x) => x.code === model);
  if (!m) return `'${model}' isn't a local model in Imference Desktop`;
  if (!m.cached && !m.active) return `'${model}' isn't downloaded in Imference Desktop`;
  return undefined;
}

/**
 * Where this generate call runs. Throws ToolRunError when run_on is 'local'
 * and Desktop can't run it.
 */
export async function planGenerate(
  ctx: ToolsContext,
  runOn: RunOn,
  payload: Partial<GeneratePayload>,
  model: string | undefined,
): Promise<GeneratePlan> {
  if (runOn === "cloud") return { where: "cloud" };
  const local = runOn === "local";
  const refuse = (code: string, why: string): GeneratePlan => {
    if (local) throw new ToolRunError(code, why);
    return { where: "cloud", note: `run_on 'auto': ran in the cloud because ${why.replace(/\.$/, "")}.` };
  };

  const cloudOnly = cloudOnlyReason(payload);
  if (cloudOnly) return refuse("not_available", `${cloudOnly} (local generation in Imference Desktop doesn't take it). Use run_on: 'cloud'.`);

  const probe = await ctx.desktop.probe();
  if (!probe.reachable) {
    if (local) throw new ToolRunError("desktop_unavailable", `${DESKTOP_NOT_RUNNING} Details: ${probe.reason}.`);
    // Desktop absent: the cloud, as before Desktop existed (no note).
    return { where: "cloud" };
  }
  const info = await ctx.desktop.generationInfo(probe.endpoint);
  if (!info) {
    return refuse(
      "not_available",
      "this Imference Desktop version can't generate for agents (update the app), or use run_on: 'cloud'.",
    );
  }
  const why = localNotPossible(info, model);
  if (why) {
    const hint = why.includes("downloaded")
      ? " Download it in Imference Desktop first, or use run_on: 'cloud'."
      : " Use run_on: 'cloud'.";
    return refuse(why.includes("downloaded") ? "model_not_cached" : "not_available", why + "." + hint);
  }
  return { where: "local", endpoint: probe.endpoint, body: localBody(payload, model, ctx.cwd) };
}

/** Run a planned local generation. A failure is a ToolRunError (no paid fallback). */
export async function runLocalGenerate(
  ctx: ToolsContext,
  plan: Extract<GeneratePlan, { where: "local" }>,
  opts: { include_image?: boolean } = {},
): Promise<ToolResult> {
  let res;
  try {
    res = await ctx.desktop.generate(plan.endpoint, plan.body);
  } catch (e) {
    if (!(e instanceof DesktopError)) throw e;
    throw new ToolRunError(
      e.code,
      `local generation in Imference Desktop failed: ${e.message}` +
        (e.code === "invalid_input" ? "" : " To run it in the cloud instead (paid), retry with run_on: 'cloud'."),
    );
  }
  const outputs: OutputSummary[] = res.outputs.map((o) => {
    const s: OutputSummary = {};
    if (typeof o.name === "string") s.name = o.name;
    if (typeof o.type === "string") s.type = o.type;
    if (typeof o.format === "string") s.format = o.format;
    if (typeof o.path === "string") s.path = o.path;
    if (typeof o.width === "number" && o.width > 0) s.width = o.width;
    if (typeof o.height === "number" && o.height > 0) s.height = o.height;
    return s;
  });
  const preview = opts.include_image === false ? [] : await previewOutputs(ctx.client, outputs);
  return ok(
    {
      status: "done",
      ran: "local",
      request_id: "local",
      model: res.model,
      seed: res.seed,
      outputs,
      path: outputs[0]?.path,
      duration_ms: res.duration_ms,
      credits: 0,
      note: "Generated on this computer by Imference Desktop (free); also saved in its gallery.",
    },
    preview,
  );
}

/** list_models: which generation models Desktop can run locally right now. */
export function localAvailability(info: DesktopGenerationInfo | undefined): Map<string, "ready" | "not_downloaded"> {
  const out = new Map<string, "ready" | "not_downloaded">();
  if (!info || info.reason === "engine_not_installed") return out;
  for (const m of info.models) out.set(m.code, m.cached || m.active ? "ready" : "not_downloaded");
  return out;
}
