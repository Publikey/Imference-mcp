#!/usr/bin/env node
/**
 * imference-mcp — MCP server (stdio) wrapping the Imference generation API.
 *
 * Environment:
 *   IMFERENCE_API_KEY              Bearer key for the credits rail
 *   IMFERENCE_WALLET_PRIVATE_KEY   EVM private key (USDC on Base) for the x402 rail
 *   IMFERENCE_X402_MAX_USD         hard cap per x402 payment (default 10; enforced
 *                                  server-side, whatever the tool call asks for)
 *   IMFERENCE_X402_SESSION_MAX_USD cumulative x402 cap for this process (default: off)
 *   IMFERENCE_BASE_RPC_URL         Base mainnet RPC for wallet_balance (default mainnet.base.org)
 *   IMFERENCE_BASE_URL             API base URL (default https://imference.com)
 *
 * At least one of API key / wallet is needed to generate; catalog tools and
 * status polling work without any credential.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  ImferenceClient,
  ImferenceError,
  isVideoModel,
  MAX_X402_CREDITS_TOPUP,
  MIN_X402_CREDITS_TOPUP,
  type GeneratePayload,
  type MediaRow,
} from "./client.js";

function envNumber(name: string, fallback?: number): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`Ignoring invalid ${name}='${raw}' (expected a non-negative number)`);
    return fallback;
  }
  return n;
}

const client = new ImferenceClient({
  baseUrl: process.env.IMFERENCE_BASE_URL ?? "https://imference.com",
  apiKey: process.env.IMFERENCE_API_KEY,
  walletPrivateKey: process.env.IMFERENCE_WALLET_PRIVATE_KEY,
  x402MaxUsdPerCall: envNumber("IMFERENCE_X402_MAX_USD", 10),
  x402SessionMaxUsd: envNumber("IMFERENCE_X402_SESSION_MAX_USD"),
  baseRpcUrl: process.env.IMFERENCE_BASE_RPC_URL,
});

const server = new McpServer({
  name: "imference",
  version: "0.1.0",
});

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type ToolResult = {
  content: ContentBlock[];
  isError?: boolean;
};

function ok(data: unknown, extra: ContentBlock[] = []): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }, ...extra] };
}

function fail(err: unknown): ToolResult {
  const message =
    err instanceof ImferenceError
      ? `Imference API error${err.status ? ` (HTTP ${err.status})` : ""}: ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

function mediaSummary(m: MediaRow) {
  return {
    request_id: m.RequestID,
    kind: m.Kind,
    url: m.URL,
    format: m.Format,
    seed: m.Seed,
    timestamp: m.Timestamp,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Don't embed images past this size — keeps tool results within client limits. */
const MAX_EMBED_BYTES = 3 * 1024 * 1024;

const MIME_BY_FORMAT: Record<string, string> = {
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
};

/**
 * Best-effort inline preview of a finished image so the agent can SEE the
 * result and iterate on its prompt. Skips videos, oversized files, and any
 * download hiccup — the URL in the JSON is always the source of truth.
 */
async function imagePreview(media: MediaRow): Promise<ContentBlock[]> {
  if (media.Kind !== "image") return [];
  try {
    const { bytes, contentType } = await client.downloadMedia(media.URL);
    if (bytes.length > MAX_EMBED_BYTES) return [];
    const mime = contentType.startsWith("image/")
      ? contentType.split(";")[0]
      : MIME_BY_FORMAT[media.Format?.toLowerCase() ?? ""];
    if (!mime) return [];
    return [{ type: "image", data: bytes.toString("base64"), mimeType: mime }];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Catalog tools (no API key required)
// ---------------------------------------------------------------------------

server.registerTool(
  "list_models",
  {
    title: "List Imference models",
    description:
      "List the available generation models with their kind (image or video), cost in credits " +
      "(1 credit = $0.001), and parameter defaults/ranges. Call this before generate to pick a " +
      "valid model_code.",
    inputSchema: {
      kind: z
        .enum(["image", "video", "all"])
        .optional()
        .describe("Filter by media kind (default: all)"),
    },
  },
  async ({ kind }) => {
    try {
      const models = await client.listModels();
      const rows = models
        .map((m) => ({
          model_code: m.model_code,
          name: m.name,
          kind: isVideoModel(m) ? "video" : "image",
          cost_credits: m.im_cost,
          description: m.short_description || m.medium_description || m.description,
          engine: m.im_engine || undefined,
          steps: { default: m.steps_default, min: m.steps_min, max: m.steps_max },
          guidance_scale: { default: m.cfg_default, min: m.cfg_min, max: m.cfg_max },
          scheduler_default: m.scheduler_default || undefined,
          frames:
            m.frames_default != null
              ? { default: m.frames_default, min: m.frames_min, max: m.frames_max }
              : undefined,
          fps:
            m.fps_default != null
              ? { default: m.fps_default, min: m.fps_min, max: m.fps_max }
              : undefined,
        }))
        .filter((m) => !kind || kind === "all" || m.kind === kind);
      return ok({ count: rows.length, models: rows });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_formats",
  {
    title: "List model formats",
    description:
      "List the supported output formats (width/height/aspect ratio) per model. Useful to pick " +
      "valid dimensions instead of guessing; each model has a default format.",
    inputSchema: {
      model: z.string().optional().describe("Filter formats for a single model_code"),
    },
  },
  async ({ model }) => {
    try {
      const formats = await client.listFormats();
      const rows = formats.filter((f) => !model || f.model_code === model);
      return ok({ count: rows.length, formats: rows });
    } catch (e) {
      return fail(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Generation tools (require IMFERENCE_API_KEY)
// ---------------------------------------------------------------------------

/**
 * Picks the payment rail: explicit request wins, otherwise credits (API key)
 * when configured, otherwise x402 (wallet).
 */
function resolveRail(requested?: "credits" | "x402"): "credits" | "x402" {
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

server.registerTool(
  "generate",
  {
    title: "Generate an image or video",
    description:
      "Submit a generation request to Imference and wait for the result. The media kind (image " +
      "or video) is determined by the model — use list_models to pick a model_code. Payment: " +
      "either the credits rail (API key balance) or the x402 rail (pay-per-generation in USDC " +
      "on Base, signed with the configured wallet); defaults to credits when an API key is set, " +
      "else x402 when a wallet is set. Returns the media URL when done; if the generation is " +
      "still running after wait_seconds, returns the request_id so you can poll with check_status.",
    inputSchema: {
      rail: z
        .enum(["credits", "x402"])
        .optional()
        .describe(
          "Payment rail: 'credits' (API key balance) or 'x402' (per-request USDC payment " +
            "on Base). Default: credits if an API key is configured, else x402.",
        ),
      model: z.string().describe("Model code from list_models"),
      prompt: z.string().describe("Text prompt describing the desired output"),
      negative_prompt: z.string().optional().describe("What to avoid (model default if omitted)"),
      width: z.number().int().positive().optional().describe("Output width in px (model's default format if omitted)"),
      height: z.number().int().positive().optional().describe("Output height in px"),
      steps: z.number().int().positive().optional().describe("Diffusion steps (model default if omitted)"),
      guidance_scale: z.number().positive().optional().describe("CFG scale (model default if omitted)"),
      seed: z.number().int().optional().describe("Seed for reproducibility (random if omitted)"),
      batch_nbr: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe(
          "Number of images to generate in one request (default 1). Note: the status result " +
            "carries the first image only — fetch the rest with list_media.",
        ),
      scheduler: z.string().optional().describe("Sampler/scheduler (model default if omitted)"),
      img_url: z
        .string()
        .url()
        .optional()
        .describe("Source image URL — for img2img on image models, or image-to-video on video models"),
      num_frames: z.number().int().positive().optional().describe("Video only: number of frames"),
      fps: z.number().int().positive().optional().describe("Video only: frames per second"),
      duration_seconds: z.number().int().positive().optional().describe("Video only: duration in seconds (models that support it)"),
      aspect_ratio: z.string().optional().describe('Aspect ratio, e.g. "16:9" (models that support it)'),
      wait_seconds: z
        .number()
        .int()
        .min(0)
        .max(600)
        .optional()
        .describe("How long to wait for completion before returning the request_id (default 120, 0 = return immediately)"),
      include_image: z
        .boolean()
        .optional()
        .describe(
          "Embed the finished image in the result so you can see it (default true; " +
            "images ≤ 3MB only, never videos)",
        ),
    },
  },
  async (args) => {
    const { wait_seconds, rail: requestedRail, include_image, ...rest } = args;
    const payload = rest as GeneratePayload;
    try {
      const rail = resolveRail(requestedRail);

      let request_id: string;
      let kind: string;
      let payment: unknown;
      if (rail === "x402") {
        // Resolve the model's catalog price so the spending guards run
        // against it and the wallet signs for exactly that amount — an
        // unknown model fails here before any payment is attempted.
        const models = await client.listModels();
        const model = models.find((m) => m.model_code === payload.model);
        if (!model) {
          return fail(
            new ImferenceError(
              `Unknown model '${payload.model}'. Use list_models to see valid model codes.`,
            ),
          );
        }
        const res = await client.generateX402(payload, model.im_cost);
        request_id = res.request_id;
        kind = res.kind;
        payment = res.payment;
      } else {
        const res = await client.generate(payload);
        request_id = res.request_id;
        kind = res.kind;
      }

      const waitMs = (wait_seconds ?? 120) * 1000;
      const deadline = Date.now() + waitMs;
      let pollDelay = 2000;

      while (Date.now() < deadline) {
        await sleep(Math.min(pollDelay, Math.max(0, deadline - Date.now())));
        pollDelay = Math.min(pollDelay * 1.5, 10_000);
        const status = await client.status(request_id);
        if (status.state === "failed") {
          return fail(new ImferenceError(status.error));
        }
        if (status.state === "done") {
          const preview = include_image === false ? [] : await imagePreview(status.media);
          return ok({ status: "done", rail, payment, ...mediaSummary(status.media) }, preview);
        }
      }

      return ok({
        status: "pending",
        request_id,
        kind,
        rail,
        payment,
        note:
          `Generation still running after ${waitMs / 1000}s. ` +
          `Poll it with the check_status tool (request_id: ${request_id}).`,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "check_status",
  {
    title: "Check a generation request",
    description:
      "Check the status of a previously submitted generation. Returns the media URL when done, " +
      "'pending' while still running, or the failure reason.",
    inputSchema: {
      request_id: z.string().describe("The request_id returned by generate"),
      include_image: z
        .boolean()
        .optional()
        .describe("Embed the finished image in the result (default true; images ≤ 3MB only)"),
    },
  },
  async ({ request_id, include_image }) => {
    try {
      const status = await client.status(request_id);
      if (status.state === "done") {
        const preview = include_image === false ? [] : await imagePreview(status.media);
        return ok({ status: "done", ...mediaSummary(status.media) }, preview);
      }
      if (status.state === "failed") return fail(new ImferenceError(status.error));
      return ok({ status: "pending", request_id });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "download_media",
  {
    title: "Download a generated media file",
    description:
      "Download a generated image or video to a local file. Pass either the media URL " +
      "(from generate / check_status / list_media) or a request_id of a finished generation.",
    inputSchema: {
      url: z.string().url().optional().describe("Media URL to download"),
      request_id: z
        .string()
        .optional()
        .describe("Alternatively, the request_id of a finished generation"),
      output_path: z
        .string()
        .describe("Destination file path (parent directories are created)"),
    },
  },
  async ({ url, request_id, output_path }) => {
    try {
      let mediaUrl = url;
      if (!mediaUrl) {
        if (!request_id) {
          return fail(new ImferenceError("Provide either url or request_id."));
        }
        const status = await client.status(request_id);
        if (status.state === "pending") {
          return fail(new ImferenceError(`Request ${request_id} is still pending — nothing to download yet.`));
        }
        if (status.state === "failed") return fail(new ImferenceError(status.error));
        mediaUrl = status.media.URL;
      }
      const { bytes, contentType } = await client.downloadMedia(mediaUrl);
      const path = resolve(output_path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
      return ok({ path, bytes: bytes.length, content_type: contentType, source_url: mediaUrl });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_balance",
  {
    title: "Get credit balance",
    description:
      "Get the remaining credit balance of the configured Imference API key (1 credit = $0.001). " +
      "Compare with a model's cost_credits from list_models before generating.",
    inputSchema: {},
  },
  async () => {
    try {
      const credits = await client.balance();
      return ok({ credits, approx_usd: credits * 0.001 });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "buy_credits_with_wallet",
  {
    title: "Buy credits with the wallet (x402)",
    description:
      "Top up an Imference API key's credit balance with a single USDC payment on Base " +
      "(price = credits × $0.001), signed by the configured wallet. Omit api_key to have the " +
      "server mint a brand-new API key and return it — save that key, it carries the credits. " +
      `Bounds: ${MIN_X402_CREDITS_TOPUP} to ${MAX_X402_CREDITS_TOPUP} credits per call ` +
      "($0.10 to $1,000). Cheaper than per-generation x402 payments when generating a lot " +
      "(one network fee instead of one per generation).",
    inputSchema: {
      credits: z
        .number()
        .int()
        .min(MIN_X402_CREDITS_TOPUP)
        .max(MAX_X402_CREDITS_TOPUP)
        .describe("Credits to buy (1 credit = $0.001 USDC)"),
      api_key: z
        .string()
        .optional()
        .describe(
          "API key to credit. Defaults to the configured IMFERENCE_API_KEY; " +
            "pass an empty string to force minting a new key.",
        ),
    },
  },
  async ({ credits, api_key }) => {
    try {
      const targetKey = api_key ?? process.env.IMFERENCE_API_KEY;
      const res = await client.addCreditsX402(credits, targetKey || undefined);
      return ok({
        api_key: res.api_key,
        credits_added: res.credits_added,
        cost_usd: credits * 0.001,
        payment: res.payment,
        note:
          targetKey && targetKey === res.api_key
            ? undefined
            : "A new API key was created — store it and set it as IMFERENCE_API_KEY to use the credits rail.",
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "payment_config",
  {
    title: "Show configured payment rails",
    description:
      "Show which payment rails this server can use: credits (IMFERENCE_API_KEY) and/or x402 " +
      "(wallet paying USDC on Base), plus the spending caps and what has been spent so far. " +
      "Returns the wallet's public address when configured — fund it with USDC on Base mainnet " +
      "to enable x402 payments. Never exposes key material.",
    inputSchema: {},
  },
  async () => {
    const caps = client.spendingCaps;
    return ok({
      base_url: process.env.IMFERENCE_BASE_URL ?? "https://imference.com",
      credits_rail: client.hasApiKey ? "configured (IMFERENCE_API_KEY set)" : "not configured",
      x402_rail: client.hasWallet
        ? {
            status: "configured",
            wallet_address: client.walletAddress,
            network: "base (mainnet)",
            currency: "USDC",
            max_usd_per_payment: caps.perCallUsd ?? "unlimited",
            session_max_usd: caps.sessionMaxUsd ?? "unlimited",
            session_spent_usd: caps.sessionSpentUsd,
          }
        : "not configured (set IMFERENCE_WALLET_PRIVATE_KEY)",
      default_rail: client.hasApiKey ? "credits" : client.hasWallet ? "x402" : "none",
    });
  },
);

server.registerTool(
  "wallet_balance",
  {
    title: "Get wallet USDC balance",
    description:
      "Read the configured wallet's USDC balance on Base mainnet (read-only RPC call). Use it " +
      "to check the wallet can cover a generation or top-up before paying. x402 payments are " +
      "gasless for the payer — only USDC is needed, no ETH.",
    inputSchema: {},
  },
  async () => {
    try {
      const { address, usdc } = await client.usdcBalance();
      return ok({ address, usdc_balance: usdc, network: "base (mainnet)" });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_media",
  {
    title: "List generated media",
    description:
      "List all images and videos previously generated with the configured API key, newest first.",
    inputSchema: {
      limit: z.number().int().positive().max(200).optional().describe("Max rows to return (default 25)"),
    },
  },
  async ({ limit }) => {
    try {
      const rows = await client.allMedia();
      const sliced = rows.slice(0, limit ?? 25);
      return ok({ total: rows.length, returned: sliced.length, media: sliced.map(mediaSummary) });
    } catch (e) {
      return fail(e);
    }
  },
);

// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("imference-mcp server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
