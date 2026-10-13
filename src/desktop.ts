/**
 * Client for Imference Desktop's local HTTP API (runs editing tools on this
 * machine, free, files never leave it).
 *
 * Discovery: IMFERENCE_DESKTOP_URL (+ IMFERENCE_DESKTOP_TOKEN) when set, else
 * the file Desktop writes at start, `<UserConfigDir>/imference-desktop-go/
 * local-api.json` = {"port", "token", "pid"}, where UserConfigDir follows Go's
 * os.UserConfigDir: %APPDATA% on Windows, ~/Library/Application Support on
 * macOS, $XDG_CONFIG_HOME (absolute) or ~/.config elsewhere.
 *
 *   GET  /v1/tools            {"tools": [{id, local_available, ...}]}
 *   POST /v1/tools/{tool_id}  {"inputs", "params"} → synchronous result
 *                             {"tool_id", "outputs": [{name, type, format, path, text?}], "duration_ms"}
 *                             or {"error": {code, message}} with HTTP 4xx/5xx
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface DesktopOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
  /** Timeout of the reachability probe (GET /v1/tools). */
  probeTimeoutMs?: number;
  /** Timeout of one synchronous local run. */
  runTimeoutMs?: number;
}

export interface DesktopEndpoint {
  url: string;
  token?: string;
  source: "env" | "discovery_file";
}

export interface DesktopTool {
  id: string;
  local_available?: boolean;
  [key: string]: unknown;
}

export interface DesktopOutput {
  name?: string;
  type?: string;
  format?: string;
  path?: string;
  text?: string;
  [key: string]: unknown;
}

export interface DesktopRunResult {
  tool_id?: string;
  outputs: DesktopOutput[];
  duration_ms?: number;
  [key: string]: unknown;
}

export type DesktopProbe =
  | { reachable: true; endpoint: DesktopEndpoint; tools: DesktopTool[] }
  | { reachable: false; reason: string };

/** A failed local run: `code` is the Desktop / engine error code. */
export class DesktopError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "DesktopError";
  }
}

export const DESKTOP_NOT_RUNNING =
  "Imference Desktop is not running (or its local API is off) — start the Imference Desktop " +
  "app on this computer to run tools locally, or use run_on: 'cloud'.";

/** Go's os.UserConfigDir. */
export function userConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (platform === "win32") return env.APPDATA || join(home, "AppData", "Roaming");
  if (platform === "darwin") return join(home, "Library", "Application Support");
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && isAbsolute(xdg)) return xdg;
  return join(home, ".config");
}

export function discoveryFilePath(opts: DesktopOptions = {}): string {
  return join(
    userConfigDir(opts.env ?? process.env, opts.platform ?? process.platform, opts.homedir ?? homedir()),
    "imference-desktop-go",
    "local-api.json",
  );
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class DesktopClient {
  constructor(private readonly opts: DesktopOptions = {}) {}

  private get env(): NodeJS.ProcessEnv {
    return this.opts.env ?? process.env;
  }

  /** Where Desktop's local API lives, or a reason it can't be found. */
  async endpoint(): Promise<DesktopEndpoint | { error: string }> {
    const envUrl = this.env.IMFERENCE_DESKTOP_URL;
    if (envUrl) {
      return {
        url: envUrl.replace(/\/+$/, ""),
        token: this.env.IMFERENCE_DESKTOP_TOKEN || undefined,
        source: "env",
      };
    }
    const file = discoveryFilePath(this.opts);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return { error: `no discovery file at ${file}` };
    }
    let doc: { port?: unknown; token?: unknown; pid?: unknown };
    try {
      doc = JSON.parse(raw);
    } catch {
      return { error: `unreadable discovery file ${file}` };
    }
    const port = Number(doc.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      return { error: `discovery file ${file} has no valid port` };
    }
    const pid = Number(doc.pid);
    if (Number.isInteger(pid) && pid > 0 && !pidAlive(pid)) {
      return { error: `stale discovery file ${file} (process ${pid} is gone)` };
    }
    return {
      url: `http://127.0.0.1:${port}`,
      token: typeof doc.token === "string" && doc.token ? doc.token : undefined,
      source: "discovery_file",
    };
  }

  private headers(ep: DesktopEndpoint, json: boolean): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json" };
    if (json) h["Content-Type"] = "application/json";
    if (ep.token) h["Authorization"] = `Bearer ${ep.token}`;
    return h;
  }

  /** Is Desktop answering, and which tools can it run locally? Never throws. */
  async probe(): Promise<DesktopProbe> {
    const ep = await this.endpoint();
    if ("error" in ep) return { reachable: false, reason: ep.error };
    try {
      const res = await fetch(`${ep.url}/v1/tools`, {
        headers: this.headers(ep, false),
        signal: AbortSignal.timeout(this.opts.probeTimeoutMs ?? 2000),
      });
      if (!res.ok) {
        return {
          reachable: false,
          reason: `local API at ${ep.url} answered HTTP ${res.status}${res.status === 401 ? " (bad token)" : ""}`,
        };
      }
      const body = (await res.json()) as { tools?: unknown };
      const tools = Array.isArray(body.tools)
        ? (body.tools.filter((t) => t && typeof (t as DesktopTool).id === "string") as DesktopTool[])
        : [];
      return { reachable: true, endpoint: ep, tools };
    } catch (e) {
      return {
        reachable: false,
        reason: `local API at ${ep.url} is not answering (${e instanceof Error ? e.message : String(e)})`,
      };
    }
  }

  /**
   * Run one tool locally (synchronous). Throws DesktopError: the Desktop
   * error code, or `desktop_unavailable` when the API can't be reached.
   */
  async run(
    ep: DesktopEndpoint,
    toolId: string,
    inputs: Record<string, string | string[]>,
    params: Record<string, unknown>,
  ): Promise<DesktopRunResult> {
    let res: Response;
    try {
      res = await fetch(`${ep.url}/v1/tools/${encodeURIComponent(toolId)}`, {
        method: "POST",
        headers: this.headers(ep, true),
        body: JSON.stringify({ inputs, params }),
        signal: AbortSignal.timeout(this.opts.runTimeoutMs ?? 15 * 60_000),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new DesktopError(
        timedOut ? "timeout" : "desktop_unavailable",
        timedOut
          ? `local run of '${toolId}' did not finish in time`
          : `${DESKTOP_NOT_RUNNING} (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const err = (body as { error?: unknown } | undefined)?.error;
    if (!res.ok || err) {
      if (err && typeof err === "object") {
        const o = err as { code?: unknown; message?: unknown };
        throw new DesktopError(
          typeof o.code === "string" ? o.code : "internal",
          typeof o.message === "string" ? o.message : `HTTP ${res.status}`,
          res.status,
        );
      }
      throw new DesktopError(
        res.status === 401 ? "unauthorized" : "internal",
        typeof err === "string" ? err : `local API answered HTTP ${res.status}`,
        res.status,
      );
    }
    const out = body as DesktopRunResult | undefined;
    if (!out || !Array.isArray(out.outputs)) {
      throw new DesktopError("internal", "local API returned no outputs");
    }
    return out;
  }
}
