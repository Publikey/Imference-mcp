/**
 * Local runs (Imference Desktop) that outlast one tool call.
 *
 * MCP clients give up on a tool call after a while (Claude Desktop: ~60 s),
 * and a local run can take longer (the engine starting, a model loading). So
 * a local run is awaited for at most `wait` seconds; still going, it's parked
 * here under a "local_…" request_id and the tool answers 'pending' —
 * check_status then picks up the same run (this server process stays up
 * between calls). Nothing is ever started twice.
 */

import { randomBytes } from "node:crypto";

import { fail, ok, type ToolResult } from "./results.js";

/** Default wait of one call: under the ~60 s MCP clients allow a tool call. */
export const LOCAL_WAIT_DEFAULT_S = 50;

interface Parked {
  outcome: Promise<ToolResult>;
  startedAt: number;
  what: string;
}

const parked = new Map<string, Parked>();

export function isLocalRequestId(id: string): boolean {
  return id.startsWith("local_");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** p's value if it settles within ms (a rejection is thrown), else undefined. */
export async function within<T>(p: Promise<T>, ms: number): Promise<{ value: T } | undefined> {
  return Promise.race([p.then((value) => ({ value })), sleep(ms).then(() => undefined)]);
}

/**
 * Park a running local job; returns its request_id. `outcome` is the final
 * tool result (errors already turned into fail() results).
 */
export function park(outcome: Promise<ToolResult>, what: string): string {
  const id = `local_${randomBytes(6).toString("hex")}`;
  parked.set(id, { outcome: outcome.catch((e) => fail(e)), startedAt: Date.now(), what });
  return id;
}

/** The 'pending' answer for a parked local job. */
export function pendingResult(id: string, what: string, waitedS: number, extra: Record<string, unknown> = {}): ToolResult {
  return ok({
    status: "pending",
    ran: "local",
    request_id: id,
    credits: 0,
    ...extra,
    note:
      `Still running on this computer in Imference Desktop after ${waitedS}s (${what}; the engine ` +
      `may be starting or loading the model). Nothing is charged. Call check_status with ` +
      `request_id ${id} to wait for it — don't start it again.`,
  });
}

/** check_status for a "local_…" id: waits up to waitMs for the parked job. */
export async function checkLocal(id: string, waitMs: number): Promise<ToolResult> {
  const job = parked.get(id);
  if (!job) {
    return fail(
      new Error(
        `Unknown local request ${id}: the Imference MCP server was restarted since. If it finished, ` +
          "the result is in Imference Desktop's gallery.",
      ),
    );
  }
  const done = await within(job.outcome, waitMs);
  if (!done) {
    return pendingResult(id, job.what, Math.round((Date.now() - job.startedAt) / 1000));
  }
  parked.delete(id);
  return done.value;
}
