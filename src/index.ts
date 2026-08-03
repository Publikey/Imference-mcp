#!/usr/bin/env node
/**
 * imference-mcp — MCP server (stdio) wrapping the Imference generation API.
 *
 * Environment:
 *   IMFERENCE_API_KEY   Bearer key for the credits rail (required for generate/
 *                       status/balance/media tools; catalog tools work without it)
 *   IMFERENCE_BASE_URL  API base URL (default https://imference.com)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  ImferenceClient,
  ImferenceError,
  isVideoModel,
  type GeneratePayload,
  type MediaRow,
} from "./client.js";

const client = new ImferenceClient({
  baseUrl: process.env.IMFERENCE_BASE_URL ?? "https://imference.com",
  apiKey: process.env.IMFERENCE_API_KEY,
});

const server = new McpServer({
  name: "imference",
  version: "0.1.0",
});

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
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

server.registerTool(
  "generate",
  {
    title: "Generate an image or video",
    description:
      "Submit a generation request to Imference and wait for the result. The media kind (image " +
      "or video) is determined by the model — use list_models to pick a model_code. Costs the " +
      "model's price in credits. Returns the media URL when done; if the generation is still " +
      "running after wait_seconds, returns the request_id so you can poll with check_status.",
    inputSchema: {
      model: z.string().describe("Model code from list_models"),
      prompt: z.string().describe("Text prompt describing the desired output"),
      negative_prompt: z.string().optional().describe("What to avoid (model default if omitted)"),
      width: z.number().int().positive().optional().describe("Output width in px (model's default format if omitted)"),
      height: z.number().int().positive().optional().describe("Output height in px"),
      steps: z.number().int().positive().optional().describe("Diffusion steps (model default if omitted)"),
      guidance_scale: z.number().positive().optional().describe("CFG scale (model default if omitted)"),
      seed: z.number().int().optional().describe("Seed for reproducibility (random if omitted)"),
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
    },
  },
  async (args) => {
    const { wait_seconds, ...rest } = args;
    const payload = rest as GeneratePayload;
    try {
      const { request_id, kind } = await client.generate(payload);
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
          return ok({ status: "done", ...mediaSummary(status.media) });
        }
      }

      return ok({
        status: "pending",
        request_id,
        kind,
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
    },
  },
  async ({ request_id }) => {
    try {
      const status = await client.status(request_id);
      if (status.state === "done") return ok({ status: "done", ...mediaSummary(status.media) });
      if (status.state === "failed") return fail(new ImferenceError(status.error));
      return ok({ status: "pending", request_id });
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
