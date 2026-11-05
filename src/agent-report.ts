/**
 * Cloud generations shown in Imference Desktop: when Desktop is running, the
 * server tells it about each cloud generate it starts and ends
 * (POST /v1/agent-runs), so the run shows in Desktop's Activity ("via
 * Claude") and its image lands in the gallery — Desktop fetches it itself
 * from the request_id. Best effort: Desktop absent or older, nothing happens.
 */

import type { DesktopClient, DesktopRunReport } from "./desktop.js";

/** Cloud runs reported as started, by request_id (ended once, from generate or check_status). */
const tracked = new Map<string, { label: string; model: string }>();

async function send(desktop: DesktopClient, body: DesktopRunReport): Promise<void> {
  try {
    const ep = await desktop.endpoint();
    if ("error" in ep) return;
    await desktop.reportRun(ep, body);
  } catch {
    /* best effort */
  }
}

export async function reportCloudStart(desktop: DesktopClient, requestId: string, label: string, model: string): Promise<void> {
  tracked.set(requestId, { label, model });
  await send(desktop, { id: requestId, state: "running", kind: "generate", label, model, request_id: requestId });
}

export async function reportCloudEnd(desktop: DesktopClient, requestId: string, state: "done" | "error", error?: string): Promise<void> {
  const t = tracked.get(requestId);
  if (!t) return;
  tracked.delete(requestId);
  await send(desktop, { id: requestId, state, kind: "generate", label: t.label, model: t.model, request_id: requestId, error });
}
