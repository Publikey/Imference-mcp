# imference-mcp

MCP (Model Context Protocol) server wrapping the [Imference](https://imference.com) AI
image & video generation API. Lets any MCP client (Claude Desktop, Claude Code, etc.)
browse the model catalog, generate images and videos, and pay — with an API key
(**credits rail**) or directly from a wallet in USDC on Base (**x402 rail**).

| Tool | Imference endpoint | Needs |
|---|---|---|
| `list_models` | `GET /api/models` | – |
| `list_formats` | `GET /api/formats` | – |
| `generate` | `POST /generate` or `POST /ondemand/generate` + polls `GET /ondemand/status` | API key or wallet |
| `check_status` | `GET /ondemand/status` | – |
| `download_media` | media blob URL | – |
| `get_balance` | `GET /credits/balance` | API key |
| `buy_credits_with_wallet` | `POST /ondemand/credits/add` | wallet |
| `wallet_balance` | Base RPC (read-only) | wallet |
| `payment_config` | – (local) | – |
| `list_media` | `GET /media/all` | API key |

Finished **images are embedded in the tool result** (base64, up to 3MB) so the agent
can see what it generated and iterate on its prompt — disable per call with
`include_image: false`. Videos are returned as URLs; `download_media` saves either
to a local file.

The media kind (image vs video) and the price come from the model catalog — see the
full [API reference](https://imference.com/docs).

## Payment rails

- **credits** — classic Bearer API key; each generation debits the model's catalog
  cost from your balance. Configured with `IMFERENCE_API_KEY`.
- **x402** — pay-per-request in USDC on Base mainnet. The server answers with an
  HTTP 402 challenge priced at the model's catalog cost; this MCP server signs an
  EIP-3009 `transferWithAuthorization` with the configured wallet key
  ([x402-fetch](https://www.npmjs.com/package/x402-fetch)) and retries with the
  `X-PAYMENT` header. Configured with `IMFERENCE_WALLET_PRIVATE_KEY`.

`generate` picks the rail automatically (credits if an API key is set, else x402) —
override per call with the `rail` argument. The wallet only ever signs up to the
model's catalog price (+ $0.01 headroom), so a typo'd model can never overcharge.

If the bot generates a lot, `buy_credits_with_wallet` is cheaper: one on-chain
payment tops up an API key (or mints a new one) instead of paying a network fee
per generation.

### Spending guards

Two caps are enforced by the server itself — whatever the LLM asks for, the guard
runs **before** any signing or network call:

- `IMFERENCE_X402_MAX_USD` — hard cap per payment (**default $10**). A
  `buy_credits_with_wallet` above it fails with an explicit message; raise the env
  var if the spend is intended.
- `IMFERENCE_X402_SESSION_MAX_USD` — cumulative cap over the server process's
  lifetime (default: off). `payment_config` reports what has been spent so far.

> ⚠️ **Wallet security** — `IMFERENCE_WALLET_PRIVATE_KEY` gives this process signing
> power over that wallet's USDC. Use a dedicated hot wallet funded with only what
> the bot should be able to spend, and keep the spending caps on. The key never
> leaves the process and is never exposed through any tool output (`payment_config`
> and `wallet_balance` report the public address only).

## Setup

```bash
npm install
npm run build
```

Requires Node.js ≥ 18.

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `IMFERENCE_API_KEY` | credits rail | Bearer API key (top up at imference.com or via `buy_credits_with_wallet`) |
| `IMFERENCE_WALLET_PRIVATE_KEY` | x402 rail | 0x-prefixed EVM private key holding USDC on Base mainnet |
| `IMFERENCE_DEFAULT_MODEL` | – | Model used when `generate` is called without one — makes the bot's model choice deterministic instead of leaving it to the LLM |
| `IMFERENCE_X402_MAX_USD` | – | Per-payment cap in USD (default `10`) |
| `IMFERENCE_X402_SESSION_MAX_USD` | – | Cumulative x402 cap per process (default: off) |
| `IMFERENCE_BASE_RPC_URL` | – | Base RPC for `wallet_balance` (default `https://mainnet.base.org`) |
| `IMFERENCE_BASE_URL` | – | API base URL (default `https://imference.com`) |

At least one of the two credentials is needed to generate. The catalog tools
(`list_models`, `list_formats`) and `check_status` work without any credential.

## Usage with Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "imference": {
      "command": "node",
      "args": ["/path/to/imference-mcp/dist/index.js"],
      "env": {
        "IMFERENCE_API_KEY": "your-api-key",
        "IMFERENCE_WALLET_PRIVATE_KEY": "0x… (optional, enables the x402 rail)"
      }
    }
  }
}
```

With Claude Code:

```bash
claude mcp add imference -e IMFERENCE_API_KEY=your-api-key -- node /path/to/imference-mcp/dist/index.js
```

## How `generate` works

1. Resolves the payment rail (explicit `rail` arg > API key > wallet).
   - credits: `POST /generate` — the model's cost is deducted from your balance.
   - x402: looks up the model's cost in the catalog, then `POST /ondemand/generate`;
     the 402 challenge is signed with the wallet and settled in USDC on Base. The
     settlement receipt (tx hash, payer) is included in the result.
2. Polls `GET /ondemand/status` (the shared, unauthenticated status handler) with
   exponential backoff (2s → 10s) for up to `wait_seconds` (default 120). The API
   maps state to HTTP codes: `404` pending, `422` failed, `200` done.
3. Returns the blob URL of the media when done. If still running (videos can take a
   while), returns the `request_id` — poll it with `check_status`.

## Development

```bash
npm run dev    # tsc --watch
npm test       # build + unit tests (mock HTTP server, no network / no real payments)
```

Smoke test the stdio server by hand:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node dist/index.js
```

## Repo layout

```
src/index.ts    MCP server: tool registration + stdio transport
src/client.ts   HTTP client for the Imference API
```
