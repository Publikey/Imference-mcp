/**
 * Tool-result helpers shared by every MCP tool: ok() / fail(), error codes,
 * and inline image previews (remote URLs and local files).
 */

import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

import { ImferenceError, type ImferenceClient } from "./client.js";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type ToolResult = {
  content: ContentBlock[];
  isError?: boolean;
};

/**
 * An editing-tool error with a catalog error code (invalid_input, too_large,
 * unsupported_runtime, weights_missing, oom, timeout, internal) or an MCP-side
 * one (desktop_unavailable, not_available, no_payment_method).
 */
export class ToolRunError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolRunError";
  }
}

export function ok(data: unknown, extra: ContentBlock[] = []): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }, ...extra] };
}

export function fail(err: unknown): ToolResult {
  let message: string;
  if (err instanceof ToolRunError) {
    message = `Tool error (${err.code}): ${err.message}`;
  } else if (err instanceof ImferenceError) {
    const parts = [err.status ? `HTTP ${err.status}` : "", err.code ?? ""].filter(Boolean);
    message = `Imference API error${parts.length ? ` (${parts.join(", ")})` : ""}: ${err.message}`;
  } else {
    message = err instanceof Error ? err.message : String(err);
  }
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Don't embed images past this size — keeps tool results within client limits. */
export const MAX_EMBED_BYTES = 3 * 1024 * 1024;

export const MIME_BY_FORMAT: Record<string, string> = {
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
};

/** Upload content types, by file extension. */
const MIME_BY_EXT: Record<string, string> = {
  ...MIME_BY_FORMAT,
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  avif: "image/avif",
  heic: "image/heic",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
};

export function mimeForPath(path: string): string {
  return MIME_BY_EXT[extname(path).slice(1).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Best-effort inline preview of a remote image so the agent can SEE the
 * result. Skips non-images, oversized files and any download hiccup — the URL
 * in the JSON is always the source of truth.
 */
export async function previewFromUrl(
  client: ImferenceClient,
  url: string,
  format?: string,
): Promise<ContentBlock[]> {
  try {
    const { bytes, contentType } = await client.downloadMedia(url);
    if (bytes.length > MAX_EMBED_BYTES) return [];
    const mime = contentType.startsWith("image/")
      ? contentType.split(";")[0]
      : MIME_BY_FORMAT[format?.toLowerCase() ?? ""];
    if (!mime) return [];
    return [{ type: "image", data: bytes.toString("base64"), mimeType: mime }];
  } catch {
    return [];
  }
}

/** Same for a local file (Desktop outputs): images ≤ MAX_EMBED_BYTES only. */
export async function previewFromFile(path: string, format?: string): Promise<ContentBlock[]> {
  try {
    const mime = MIME_BY_FORMAT[format?.toLowerCase() ?? ""] ?? MIME_BY_FORMAT[extname(path).slice(1).toLowerCase()];
    if (!mime) return [];
    const st = await stat(path);
    if (!st.isFile() || st.size > MAX_EMBED_BYTES) return [];
    const bytes = await readFile(path);
    return [{ type: "image", data: bytes.toString("base64"), mimeType: mime }];
  } catch {
    return [];
  }
}
