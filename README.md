# imference-mcp

MCP server for [Imference](https://imference.com) — AI image & video generation
for agents. 45+ image models and 3 video models behind four tools an LLM can
drive end-to-end: browse the catalog, learn how to prompt each model, generate,
and see the result. Plus a set of editing tools (remove background, upscale,
describe, inpaint, crop, video trim…) that run in the cloud or locally, for
free, in [Imference Desktop](#editing-tools).

Works with any MCP client: Claude Code, Claude Desktop, Cursor, etc.

- **The agent sees what it generates** — finished images are embedded in the
  tool result, so the model can judge the output and iterate on its prompt.
- **Catalog-driven, always in sync** — model descriptions, parameter bounds and
  prices come live from the API; the parameter list is the exact one the server
  validates against.
- **Per-model prompting knowledge** — `get_model` tells the agent whether a
  model wants booru tags or natural language, the recommended quality prefix,
  and the default negative prompt.
- **LoRAs on request** — stack curated LoRAs (styles, characters, effects) with
  pre-tuned weights, on SDXL, Pony, Illustrious, Z-Image, Krea 2 and Anima
  models. Opt-in: the agent only adds one when you ask for it.
- **Editing tools, local or cloud** — remove backgrounds, upscale, caption,
  edit with plain-words instructions, inpaint/outpaint, crop, convert, trim and join videos. They run for free on
  your machine when Imference Desktop is open, in the cloud otherwise.
- **Two payment rails** — a classic prepaid API key, or pay-per-generation in
  USDC on Base ([x402](https://www.x402.org/)) straight from a wallet, with
  hard spending caps enforced server-side.

## Quickstart

With Claude Code:

```bash
claude mcp add imference -e IMFERENCE_API_KEY=your-api-key -- npx -y imference-mcp
```

Or in a `mcpServers` config (Claude Desktop, etc.):

```json
{
  "mcpServers": {
    "imference": {
      "command": "npx",
      "args": ["-y", "imference-mcp"],
      "env": { "IMFERENCE_API_KEY": "your-api-key" }
    }
  }
}
```

> **Note** — the first `npx` launch downloads the package; if your MCP client
> times out during that cold start and the server never comes up afterwards,
> the npx cache was likely left half-written: clear it
> (`rm -rf "$(npm config get cache)/_npx"`) and retry, or install permanently
> with `npm i -g imference-mcp` and use `imference-mcp` as the command.

Get an API key and credits at [imference.com](https://imference.com) — or skip
the key entirely and pay per generation from a wallet (see
[Payment rails](#payment-rails)). Generation costs start at 3 credits
($0.003) per image.

Then just ask your agent:

> Generate a photorealistic banner image of a lighthouse in a storm.
> Pick the best model for it and apply its prompting recommendations.

The agent will list the models, read the chosen model's card, prepend its
recommended quality tags, pick a banner format, generate, and show the result.

## Tools

| Tool | Purpose | Needs |
|---|---|---|
| `list_models` | Model overview for picking: kind, style family, prompt style, cost, capabilities | – |
| `get_model` | One model in full: description, prompting recommendations, exact parameters & bounds, formats & price multipliers | – |
| `list_formats` | Predefined output formats per model (`square`, `portrait`, `landscape-wide`, …) | – |
| `list_loras` | Curated LoRAs: category, compatible families, weight bounds, trigger words | – |
| `generate` | Submit a generation and wait; embeds the finished image in the result | API key or wallet |
| `check_status` | Poll a still-running generation | – |
| `download_media` | Save an image or video to a local file | – |
| `get_balance` | Remaining credits of the API key | API key |
| `list_media` | Previously generated media, newest first | API key |
| `buy_credits_with_wallet` | Top up (or mint) an API key with one USDC payment | wallet |
| `wallet_balance` | USDC balance of the configured wallet (read-only) | wallet |
| `payment_config` | Which rails are configured, caps, session spend | – |
| `list_tools` | Editing tools with prices, cloud/local availability, and whether Imference Desktop is running | – |
| `remove_background`, `upscale`, `describe_image`, … | One tool per editing tool — see [Editing tools](#editing-tools) | API key or wallet (cloud), Imference Desktop (local) |

Output size and aspect ratio are selected with `format_code` — a predefined
format the API translates into dimensions and that carries the price
multiplier. Raw width/height are deliberately not exposed.

## Editing tools

Each tool of the Imference editing catalog is its own MCP tool. The list comes
from `GET /api/tools` at startup (a snapshot ships with the package and is used
when the API can't be reached within 2.5 s), so new tools appear without an
update. Current catalog:

| Tool | What it does | Cloud price |
|---|---|---|
| `remove_background` | Cut out the subject: transparent PNG, a mask, or a solid color | 3 credits |
| `upscale` | ×2 / ×4 super-resolution | 4 credits |
| `describe_image` | Detailed caption, ready to reuse as a prompt | 2 credits |
| `select_object` | Mask of an object from one or more clicks (`points`) | 1 credit |
| `erase_object` | Remove the masked object and fill the hole | 4 credits |
| `restore_faces` | Restore faces (local only) | – |
| `crop`, `resize`, `convert`, `strip_metadata` | Basic image edits | 1 credit |
| `edit_with_instructions` | Edit an image from a plain-words instruction ("replace the background with a beach at sunset"), with up to 2 optional reference images — instruction-edit `model`, default `qwen-image-edit-2511` | the model's price |
| `inpaint`, `outpaint`, `vary_image` | Repaint a masked area, extend the canvas, make a variation — with a generation `model` | the model's price |
| `video_trim`, `video_convert`, `video_concat`, `interpolate_frames` | Video edits | 2–6 credits |

`list_tools` shows the live list, prices, and where each tool can run right now.

**`edit_with_instructions`** takes `image`, an `instruction` and optionally
`references` (a list of 1–2 images, referred to in the instruction as *image 2*
and *image 3*; the edited image is image 1), plus `negative_prompt`, `steps`,
`guidance`, `keep_size` and `seed`. `model` must be an instruction-edit model —
`list_models` / `get_model` mark them `edit_model` (catalog engine
`qwenimage-edit`). When `model` is omitted it defaults to
`IMFERENCE_DEFAULT_EDIT_MODEL`, else `qwen-image-edit-2511`; this default
applies to this tool only — `inpaint`, `outpaint` and `vary_image` still require
`model`. Cloud price (credits or x402) is the chosen model's generation price.
Instruction examples: "remove the person on the left", "change the text on the
sign to OPEN", "put the hat from image 2 on the man".

**Inputs** take a local file path, an https URL or a `data:` URI (a list for
multi-file inputs like `video_concat`'s `videos`). Params are validated here
with the same rules as the engine — a bad value fails with `invalid_input`
before anything is uploaded or paid.

**`run_on`** picks where the tool runs:

- `auto` (default) — locally in Imference Desktop when it's running and can run
  this tool, else in the cloud. If the local run fails with `oom`,
  `unsupported_runtime` or `weights_missing`, it is retried in the cloud and
  the result says so (`"ran in the cloud because local failed with oom: …"`) —
  never silently.
- `local` — Imference Desktop only (free; files never leave the machine).
  Fails with a clear message when Desktop isn't running.
- `cloud` — the Imference API, paid with the same rails as `generate`
  (credits or x402, `rail` argument). Local files are uploaded (multipart);
  URLs and data URIs are passed as-is. The x402 price is the tool's credits ×
  $0.001 (generation tools: the model's price), checked against the spending
  guards before paying.

**Local runs** use Imference Desktop's local API, found through the file
Desktop writes at start (`<config dir>/imference-desktop-go/local-api.json`:
`%APPDATA%` on Windows, `~/Library/Application Support` on macOS,
`$XDG_CONFIG_HOME` or `~/.config` on Linux), or `IMFERENCE_DESKTOP_URL` +
`IMFERENCE_DESKTOP_TOKEN`. Outputs are local file paths.

**Results** are a JSON summary — `ran` (`local` / `cloud`), `request_id`
(`"local"` for local runs), `outputs` (`url` or `path`, `format`, …), `text`
for `describe_image`, `credits`, `duration_ms` — plus the image outputs
embedded (≤ 3 MB) so the agent can see them. A cloud run still going after
`wait_seconds` (default 120) returns its `request_id` for `check_status`.

Examples — just ask your agent:

> Remove the background of ~/Pictures/product.jpg and upscale the result ×2.

> Describe this image and generate a variation of it with a different model:
> https://example.com/photo.png

> Trim ~/clips/intro.mp4 to the first 5 seconds, in the cloud.

> In ~/Pictures/shop.jpg, change the text on the sign to OPEN.

Errors carry the catalog code: `invalid_input` and `too_large` (never charged),
`unsupported_runtime`, `weights_missing`, `oom`, `timeout`, `internal`; plus
`desktop_unavailable` / `not_available` for routing.

## Payment rails

- **credits** — Bearer API key; each generation debits the model's catalog
  cost from your balance. Set `IMFERENCE_API_KEY`.
- **x402** — pay-per-request in USDC on Base mainnet, no account needed. The
  server answers with an HTTP 402 challenge priced at the request's catalog
  cost; this MCP server signs an EIP-3009 `transferWithAuthorization` with the
  configured wallet ([x402-fetch](https://www.npmjs.com/package/x402-fetch))
  and retries with the `X-PAYMENT` header. Gasless for the payer — only USDC
  needed, no ETH. Set `IMFERENCE_WALLET_PRIVATE_KEY`.

`generate` picks the rail automatically (credits if an API key is set, else
x402) — override per call with the `rail` argument. The wallet only ever signs
up to the request's catalog price (+ $0.01 headroom) — base cost scaled by the
chosen format, clip duration and batch size, the same formula the API prices
the challenge with — so a typo'd request can never overcharge.

Generating a lot? `buy_credits_with_wallet` is cheaper: one on-chain payment
tops up an API key (or mints a new one) instead of paying per generation.

### Spending guards

Two caps are enforced by this server itself — whatever the LLM asks for, the
guard runs **before** any signing or network call:

- `IMFERENCE_X402_MAX_USD` — hard cap per payment (**default $10**).
- `IMFERENCE_X402_SESSION_MAX_USD` — cumulative cap over the server process's
  lifetime (default: off). `payment_config` reports what has been spent.

> ⚠️ **Wallet security** — `IMFERENCE_WALLET_PRIVATE_KEY` gives this process
> signing power over that wallet's USDC. Use a dedicated hot wallet funded with
> only what the bot should be able to spend, and keep the spending caps on. The
> key never leaves the process and is never exposed through any tool output
> (`payment_config` and `wallet_balance` report the public address only).

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `IMFERENCE_API_KEY` | credits rail | Bearer API key (top up at imference.com or via `buy_credits_with_wallet`) |
| `IMFERENCE_WALLET_PRIVATE_KEY` | x402 rail | 0x-prefixed EVM private key holding USDC on Base mainnet |
| `IMFERENCE_DEFAULT_MODEL` | – | Model used when `generate` is called without one — makes the bot's model choice deterministic |
| `IMFERENCE_DEFAULT_EDIT_MODEL` | – | Model used when `edit_with_instructions` is called without one (default `qwen-image-edit-2511`) |
| `IMFERENCE_X402_MAX_USD` | – | Per-payment cap in USD (default `10`) |
| `IMFERENCE_X402_SESSION_MAX_USD` | – | Cumulative x402 cap per process (default: off) |
| `IMFERENCE_BASE_RPC_URL` | – | Base RPC for `wallet_balance` (default `https://mainnet.base.org`) |
| `IMFERENCE_BASE_URL` | – | API base URL (default `https://imference.com`) |
| `IMFERENCE_DESKTOP_URL` | – | Imference Desktop local API URL (default: read from Desktop's discovery file) |
| `IMFERENCE_DESKTOP_TOKEN` | – | Bearer token for `IMFERENCE_DESKTOP_URL` |
| `IMFERENCE_TOOLS_CATALOG` | – | `bundled` = don't fetch the live editing-tool catalog at startup |

At least one of the two credentials is needed to generate or to run an editing
tool in the cloud. The catalog tools, `check_status` and local editing-tool runs
(Imference Desktop) work without any credential.

## How `generate` works

1. Resolves the payment rail (explicit `rail` arg > API key > wallet).
2. Submits the request — credits: `POST /generate`; x402: prices the request
   from the catalog, then `POST /ondemand/generate` with the signed payment.
3. Polls the status endpoint with exponential backoff for up to `wait_seconds`
   (default 120). Images are usually ready in well under a minute; videos can
   take longer — if still running, the tool returns a `request_id` to poll
   with `check_status`.
4. Returns the media URL, and embeds the image (≤ 3 MB) in the result so the
   agent can see it. `download_media` saves it locally — generated URLs live
   on ephemeral storage, so download what you want to keep.

### LoRAs

`generate` takes `loras: [{ code, weight? }]` (at most 4, codes from
`list_loras`, the LoRA's default weight when omitted, same price). The API
checks that each LoRA fits the model's family and that the weight is in
bounds. Trigger words are not added for you: put them in the prompt.

LoRAs are **opt-in by design**. A LoRA strongly changes the output — some are
deliberately lo-fi or stylized — so the tool descriptions tell the agent to
use one only when the user asks for it (or for a style/effect only a LoRA
provides), and otherwise to suggest it rather than add it. `get_model` only
flags whether a model accepts LoRAs; it doesn't list them.

Full API reference: [imference.com/docs](https://imference.com/docs).

## Development

```bash
npm install
npm run build
npm test        # unit tests — mock HTTP servers, no network, no real payments
```

The editing-tool catalog snapshot is `src/tools-catalog.json`; refresh it from
the engine when manifests change:
`python -m imference_engine.tools export > src/tools-catalog.json`.

Requires Node.js ≥ 18. Run the server locally instead of via npx:

```bash
claude mcp add imference -e IMFERENCE_API_KEY=your-api-key -- node /path/to/imference-mcp/dist/index.js
```

Smoke test the stdio server by hand:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node dist/index.js
```

### Releasing

Releases are tag-driven and published by CI (`.github/workflows/release.yml`) —
never run `npm publish` by hand:

```bash
npm version patch   # or minor / major — bumps package.json, commits, tags vX.Y.Z
git push --follow-tags
```

The workflow refuses a tag that doesn't match `package.json`, runs the tests,
publishes to npm with provenance, and creates the GitHub release.

Repo layout:

```
src/index.ts    MCP server: tool registration + stdio transport
src/client.ts   HTTP client for the Imference API (catalog, pricing, x402)
test/           unit tests against a local mock server
```

## License

[MIT](LICENSE)
