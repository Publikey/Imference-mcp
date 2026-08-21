# imference-mcp

MCP server for [Imference](https://imference.com) — AI image & video generation
for agents. 45+ image models and 3 video models behind four tools an LLM can
drive end-to-end: browse the catalog, learn how to prompt each model, generate,
and see the result.

Works with any MCP client: Claude Code, Claude Desktop, Cursor, etc.

- **The agent sees what it generates** — finished images are embedded in the
  tool result, so the model can judge the output and iterate on its prompt.
- **Catalog-driven, always in sync** — model descriptions, parameter bounds and
  prices come live from the API; the parameter list is the exact one the server
  validates against.
- **Per-model prompting knowledge** — `get_model` tells the agent whether a
  model wants booru tags or natural language, the recommended quality prefix,
  and the default negative prompt.
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
| `generate` | Submit a generation and wait; embeds the finished image in the result | API key or wallet |
| `check_status` | Poll a still-running generation | – |
| `download_media` | Save an image or video to a local file | – |
| `get_balance` | Remaining credits of the API key | API key |
| `list_media` | Previously generated media, newest first | API key |
| `buy_credits_with_wallet` | Top up (or mint) an API key with one USDC payment | wallet |
| `wallet_balance` | USDC balance of the configured wallet (read-only) | wallet |
| `payment_config` | Which rails are configured, caps, session spend | – |

Output size and aspect ratio are selected with `format_code` — a predefined
format the API translates into dimensions and that carries the price
multiplier. Raw width/height are deliberately not exposed.

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
| `IMFERENCE_X402_MAX_USD` | – | Per-payment cap in USD (default `10`) |
| `IMFERENCE_X402_SESSION_MAX_USD` | – | Cumulative x402 cap per process (default: off) |
| `IMFERENCE_BASE_RPC_URL` | – | Base RPC for `wallet_balance` (default `https://mainnet.base.org`) |
| `IMFERENCE_BASE_URL` | – | API base URL (default `https://imference.com`) |

At least one of the two credentials is needed to generate. The catalog tools
and `check_status` work without any credential.

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

Full API reference: [imference.com/docs](https://imference.com/docs).

## Development

```bash
npm install
npm run build
npm test        # unit tests — mock HTTP server, no network, no real payments
```

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

Repo layout:

```
src/index.ts    MCP server: tool registration + stdio transport
src/client.ts   HTTP client for the Imference API (catalog, pricing, x402)
test/           unit tests against a local mock server
```

## License

[MIT](LICENSE)
