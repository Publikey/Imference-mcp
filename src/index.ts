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
 *   IMFERENCE_DESKTOP_URL / _TOKEN override Imference Desktop's local API discovery
 *                                  (default: <UserConfigDir>/imference-desktop-go/local-api.json)
 *   IMFERENCE_TOOLS_CATALOG        'bundled' = skip fetching the live editing-tool catalog
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
  acceptsLoras,
  computeCreditCost,
  ImferenceClient,
  ImferenceError,
  isVideoModel,
  MAX_LORAS,
  MAX_X402_CREDITS_TOPUP,
  MIN_X402_CREDITS_TOPUP,
  resolveFormat,
  type GeneratePayload,
  type MediaRow,
} from "./client.js";
import { loadCatalog, type Catalog } from "./catalog.js";
import { DesktopClient } from "./desktop.js";
import { fail, ok, previewFromUrl, type ContentBlock } from "./results.js";
import {
  buildMcpTool,
  isToolMedia,
  listToolsSummary,
  previewOutputs,
  resolveRail as resolveRailFor,
  runEditTool,
  summarizeToolMedia,
  waitForStatus,
  type ToolsContext,
} from "./tools.js";

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

/** Operator-chosen model used when a generate call doesn't name one. */
const DEFAULT_MODEL = process.env.IMFERENCE_DEFAULT_MODEL;

const server = new McpServer({
  name: "imference",
  version: "0.3.0",
});

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

/**
 * Best-effort inline preview of a finished image so the agent can SEE the
 * result and iterate on its prompt. Skips videos, oversized files, and any
 * download hiccup — the URL in the JSON is always the source of truth.
 */
async function imagePreview(media: MediaRow): Promise<ContentBlock[]> {
  if (media.Kind !== "image") return [];
  return previewFromUrl(client, media.URL, media.Format);
}

// ---------------------------------------------------------------------------
// Catalog tools (no API key required)
// ---------------------------------------------------------------------------

server.registerTool(
  "list_models",
  {
    title: "List Imference models",
    description:
      "Overview of the generation models, made for PICKING the right one for the need: kind " +
      "(image or video), style/family, one-line description, cost in credits (1 credit = " +
      "$0.001), and capabilities (img2img, audio). Once a model is chosen, call get_model for " +
      "its full description, recommended prompting and exact parameter bounds before generating.",
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
          family: m.family_name || undefined,
          // How this model wants to be prompted — decisive for output quality.
          prompt_style:
            m.family_prompt_style === "tags"
              ? "tags (comma-separated booru-style tags)"
              : m.family_prompt_style === "natural"
                ? "natural language"
                : undefined,
          img2img: m.accepts_image_input ? true : undefined,
          audio: m.has_audio ? true : undefined,
          max_duration_s: m.duration_s_max ?? undefined,
        }))
        .filter((m) => !kind || kind === "all" || m.kind === kind);
      return ok({
        count: rows.length,
        models: rows,
        note: "Call get_model with a model_code for full details (parameters, bounds, formats, prompting tips).",
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_model",
  {
    title: "Get full details of one model",
    description:
      "Everything about one model before generating with it: full description, how to prompt it " +
      "(style and recommended prompt prefix), the exact parameters it accepts with bounds and " +
      "defaults (the same list the API validates against — anything else is refused with a 400), " +
      "its output formats with price multipliers, and its capabilities.",
    inputSchema: {
      model: z.string().describe("Model code from list_models"),
    },
  },
  async ({ model }) => {
    try {
      const [models, formats] = await Promise.all([client.listModels(), client.listFormats()]);
      const m = models.find((x) => x.model_code === model);
      if (!m) {
        return fail(
          new ImferenceError(`Unknown model '${model}'. Use list_models to see valid model codes.`),
        );
      }
      return ok({
        model_code: m.model_code,
        name: m.name,
        kind: isVideoModel(m) ? "video" : "image",
        family: m.family_name || undefined,
        cost_credits: m.im_cost,
        cost_note:
          "Base cost per generation. Multiplied by the chosen format's credit_multiplier, " +
          "by batch_nbr, and (video) by the clip duration over the model's default.",
        description: m.medium_description || m.short_description || undefined,
        details: m.description || undefined,
        prompting: {
          style:
            m.family_prompt_style === "tags"
              ? "tags — comma-separated booru-style tags (quality tags, subject, setting), not sentences"
              : "natural language sentences",
          // The API does NOT prepend it — the client is expected to.
          recommended_prompt_prefix: m.prompt_pre
            ? { value: m.prompt_pre, note: "Prepend this to your prompt yourself for best quality." }
            : undefined,
          default_negative_prompt: m.prompt_negative
            ? {
                value: m.prompt_negative,
                note:
                  "Applied by the server when negative_prompt is omitted. Sending your own " +
                  "REPLACES it entirely — to add exclusions, include these tags plus yours.",
              }
            : undefined,
        },
        // The enforced schema: what generate may send for this model.
        parameters: m.parameters ?? undefined,
        formats: formats
          .filter((f) => f.model_code === m.model_code)
          .map((f) => ({
            format_code: f.format_code,
            width: f.width,
            height: f.height,
            ratio: f.ratio,
            is_default: f.is_default,
            credit_multiplier: f.credit_multiplier ?? 1,
          })),
        capabilities: {
          image_input: m.accepts_image_input
            ? { max_images: m.image_input_max ?? 1, note: "Pass a source image with img_url." }
            : false,
          audio: !!m.has_audio,
          // Opt-in only — see list_loras. A flag, not a list, on purpose.
          loras: acceptsLoras(m)
            ? { max: MAX_LORAS, note: "Only when the user asks for one — see list_loras." }
            : false,
        },
      });
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
      "List the predefined output formats per model: format_code (e.g. 'square', 'portrait', " +
      "'landscape-wide'), its resolution/ratio, and its price multiplier (credit_multiplier — HD " +
      "tiers bill more). Pass a format_code to generate to pick a size; each model has a default.",
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

const LORA_OPT_IN =
  "LoRAs are OPT-IN: only use one when the user explicitly asks for a LoRA, or for a specific " +
  "style / character / effect they want added that the model can't do on its own. A LoRA " +
  "strongly changes the output (some are deliberately lo-fi or stylized), so never add one " +
  "on your own initiative to 'improve' an image — if one looks relevant, SUGGEST it to the " +
  "user and wait for their go-ahead.";

server.registerTool(
  "list_loras",
  {
    title: "List curated LoRAs",
    description:
      "List the curated LoRAs (add-ons that push a style, character or effect on top of a " +
      "model) with their pre-tuned weights and trigger words. " +
      LORA_OPT_IN +
      " Don't call this before every generation — only when LoRAs are in play. Pass model to " +
      "keep the ones that go on that model (a LoRA only works on its compatible families).",
    inputSchema: {
      model: z.string().optional().describe("Only the LoRAs compatible with this model_code"),
      category: z
        .string()
        .optional()
        .describe("Filter by category: style, character, concept, clothing, pose, detail, other"),
    },
  },
  async ({ model, category }) => {
    try {
      const loras = await client.listLoras(model);
      const rows = loras
        .filter((l) => !category || l.category === category)
        .map((l) => ({
          lora_code: l.lora_code,
          name: l.name,
          category: l.category || undefined,
          description: l.medium_description || l.short_description || undefined,
          // Full write-up: usually carries the creator's prompting tips.
          details: l.description || undefined,
          compatible_families: l.compatible_family_codes,
          weight: { default: l.weight_default, min: l.weight_min, max: l.weight_max },
          trigger_words: l.trigger_words.length
            ? {
                words: l.trigger_words,
                note:
                  l.text_encoder_trained === false
                    ? "Optional: this LoRA applies regardless of the prompt; the words can reinforce it."
                    : "Add them to the prompt yourself — the server doesn't.",
              }
            : undefined,
        }));
      return ok({
        count: rows.length,
        loras: rows,
        usage:
          `Pass loras: [{ code: lora_code, weight? }] to generate (at most ${MAX_LORAS}; ` +
          "weight_default when omitted; same price). " + LORA_OPT_IN,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Generation tools (require IMFERENCE_API_KEY)
// ---------------------------------------------------------------------------

function resolveRail(requested?: "credits" | "x402"): "credits" | "x402" {
  return resolveRailFor(client, requested);
}

server.registerTool(
  "generate",
  {
    title: "Generate an image or video",
    description:
      "Submit a generation request to Imference and wait for the result. The media kind (image " +
      "or video) is determined by the model — use list_models to pick a model_code, and " +
      "get_model to learn how to prompt it and which parameters it accepts. Size and " +
      "aspect ratio are chosen with format_code (a predefined format from list_formats), never " +
      "with raw dimensions. Payment: " +
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
      model: DEFAULT_MODEL
        ? z
            .string()
            .optional()
            .describe(
              `Model code from list_models. Defaults to '${DEFAULT_MODEL}' (operator-configured) — ` +
                "only pick a different model when the user asks for a specific style or for video.",
            )
        : z.string().describe("Model code from list_models"),
      prompt: z.string().describe("Text prompt describing the desired output"),
      negative_prompt: z.string().optional().describe("What to avoid (model default if omitted)"),
      format_code: z
        .string()
        .optional()
        .describe(
          "Output size/ratio as a predefined format code from list_formats, e.g. 'square', " +
            "'portrait', 'landscape-wide' (model's default format if omitted). This is the ONLY " +
            "way to pick a size or aspect ratio — raw dimensions are not accepted. Some formats " +
            "(HD tiers) multiply the price; list_formats shows each one's credit_multiplier.",
        ),
      steps: z.number().int().positive().optional().describe("Diffusion steps (model default if omitted)"),
      guidance_scale: z.number().positive().optional().describe("CFG scale (model default if omitted)"),
      seed: z.number().int().optional().describe("Seed for reproducibility (random if omitted)"),
      batch_nbr: z
        .number()
        .int()
        .min(1)
        .max(4)
        .optional()
        .describe(
          "Number of images to generate in one request (default 1, max 4). Each image is " +
            "billed. Note: the status result carries the first image only — fetch the rest " +
            "with list_media.",
        ),
      scheduler: z.string().optional().describe("Sampler/scheduler (model default if omitted)"),
      img_url: z
        .string()
        .url()
        .optional()
        .describe("Source image URL — for img2img on image models, or image-to-video on video models"),
      loras: z
        .array(
          z.object({
            code: z.string().describe("lora_code from list_loras"),
            weight: z
              .number()
              .optional()
              .describe("Strength within the LoRA's weight bounds (its default if omitted)"),
          }),
        )
        .max(MAX_LORAS)
        .optional()
        .describe(
          "OMIT unless the user asked for it. Curated LoRAs to stack on the model (codes from " +
            "list_loras, compatible with the model; same price). " +
            LORA_OPT_IN,
        ),
      num_frames: z.number().int().positive().optional().describe("Video only: number of frames"),
      fps: z.number().int().positive().optional().describe("Video only: frames per second"),
      duration_s: z
        .number()
        .positive()
        .optional()
        .describe(
          "Video only: clip length in seconds, for models whose duration_s in list_models says " +
            "the knob exists. Billed proportionally to the model's default duration (a 10s clip " +
            "on a 5s-default model costs ×2).",
        ),
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
      payload.model = payload.model || DEFAULT_MODEL || "";
      if (!payload.model) {
        return fail(
          new ImferenceError(
            "No model specified and no IMFERENCE_DEFAULT_MODEL configured. " +
              "Pick a model_code with list_models.",
          ),
        );
      }
      const rail = resolveRail(requestedRail);

      let request_id: string;
      let kind: string;
      let payment: unknown;
      if (rail === "x402") {
        // Resolve the catalog price of THIS request — im_cost scaled by the
        // chosen format, clip duration and batch size, the same formula the
        // API prices the 402 challenge with — so the spending guards run
        // against the real amount and the wallet signs for exactly that.
        // An unknown model or format fails here, before any payment.
        const [models, allFormats] = await Promise.all([client.listModels(), client.listFormats()]);
        const model = models.find((m) => m.model_code === payload.model);
        if (!model) {
          return fail(
            new ImferenceError(
              `Unknown model '${payload.model}'. Use list_models to see valid model codes.`,
            ),
          );
        }
        const formats = allFormats.filter((f) => f.model_code === payload.model);
        const format = resolveFormat(formats, payload.format_code);
        if (payload.format_code && format?.format_code.toLowerCase() !== payload.format_code.trim().toLowerCase()) {
          return fail(
            new ImferenceError(
              `Unknown format_code '${payload.format_code}' for ${payload.model}. ` +
                "Use list_formats to see its valid format codes.",
            ),
          );
        }
        const res = await client.generateX402(payload, computeCreditCost(model, format, payload));
        request_id = res.request_id;
        kind = res.kind;
        payment = res.payment;
      } else {
        const res = await client.generate(payload);
        request_id = res.request_id;
        kind = res.kind;
      }

      const waitMs = (wait_seconds ?? 120) * 1000;
      const status = await waitForStatus(client, request_id, waitMs);
      if (status.state === "failed") {
        return fail(new ImferenceError(status.error, undefined, status.code));
      }
      if (status.state === "done") {
        const preview = include_image === false ? [] : await imagePreview(status.media);
        return ok(
          { status: "done", rail, payment, loras: payload.loras, ...mediaSummary(status.media) },
          preview,
        );
      }

      return ok({
        status: "pending",
        request_id,
        kind,
        rail,
        payment,
        loras: payload.loras,
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
    title: "Check a generation or tool request",
    description:
      "Check the status of a previously submitted generation or cloud editing-tool run. Returns " +
      "the media URL (tools: every output, plus the text of describe_image) when done, 'pending' " +
      "while still running, or the failure reason.",
    inputSchema: {
      request_id: z.string().describe("The request_id returned by generate or an editing tool"),
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
        if (isToolMedia(status.media)) {
          const summary = summarizeToolMedia(status.media);
          const preview = include_image === false ? [] : await previewOutputs(client, summary.outputs);
          return ok({ status: "done", ...summary }, preview);
        }
        const preview = include_image === false ? [] : await imagePreview(status.media);
        return ok({ status: "done", ...mediaSummary(status.media) }, preview);
      }
      if (status.state === "failed") return fail(new ImferenceError(status.error, undefined, status.code));
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
      default_model: DEFAULT_MODEL ?? "none (the agent picks from list_models)",
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
// Editing tools (one MCP tool per catalog entry) + list_tools
// ---------------------------------------------------------------------------

const desktop = new DesktopClient();
const toolsCtx: ToolsContext = { client, desktop };

function registerEditingTools(catalog: Catalog): void {
  server.registerTool(
    "list_tools",
    {
      title: "List editing tools",
      description:
        "List the image/video editing tools (remove background, upscale, describe, inpaint, " +
        "crop, convert, video trim/join...) with their price per cloud run (1 credit = $0.001), " +
        "whether each runs in the cloud and/or locally in Imference Desktop (free), and whether " +
        "Desktop is running right now. Each tool is also its own MCP tool (the `tool` name).",
      inputSchema: {
        category: z
          .enum(["image", "video", "generation", "all"])
          .optional()
          .describe("Filter by category (default: all)"),
      },
    },
    async ({ category }) => {
      try {
        return ok(listToolsSummary(catalog, await desktop.probe(), category));
      } catch (e) {
        return fail(e);
      }
    },
  );

  const taken = new Set([
    "list_models", "get_model", "list_formats", "list_loras", "generate", "check_status",
    "download_media", "get_balance", "buy_credits_with_wallet", "payment_config",
    "wallet_balance", "list_media", "list_tools",
  ]);
  for (const tool of catalog.tools) {
    if (taken.has(tool.mcp_name)) {
      console.error(`Skipping editing tool '${tool.id}': MCP name '${tool.mcp_name}' is already used`);
      continue;
    }
    let def;
    try {
      def = buildMcpTool(tool);
    } catch (e) {
      console.error(`Skipping editing tool '${tool.id}': ${e instanceof Error ? e.message : e}`);
      continue;
    }
    taken.add(def.name);
    server.registerTool(
      def.name,
      { title: def.title, description: def.description, inputSchema: def.inputSchema },
      async (args: unknown) => runEditTool(toolsCtx, def, (args ?? {}) as Record<string, unknown>),
    );
  }
}

async function main() {
  const catalog = await loadCatalog(client, {
    timeoutMs: 2500,
    bundledOnly: process.env.IMFERENCE_TOOLS_CATALOG === "bundled",
  });
  if (catalog.source === "bundled" && catalog.fallback_reason) {
    console.error(`Editing tools: using the bundled catalog (${catalog.fallback_reason})`);
  }
  registerEditingTools(catalog);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("imference-mcp server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
