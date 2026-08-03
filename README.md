# imference-mcp

MCP (Model Context Protocol) server wrapping the [Imference](https://imference.com) AI
image & video generation API. Lets any MCP client (Claude Desktop, Claude Code, etc.)
browse the model catalog, generate images and videos, and manage credits.

Wraps the **credits rail** of the Imference API (Bearer API key):

| Tool | Imference endpoint | Auth |
|---|---|---|
| `list_models` | `GET /api/models` | – |
| `list_formats` | `GET /api/formats` | – |
| `generate` | `POST /generate` + polls `GET /status` | ✅ |
| `check_status` | `GET /status` | ✅ |
| `get_balance` | `GET /credits/balance` | ✅ |
| `list_media` | `GET /media/all` | ✅ |

The media kind (image vs video) and the price come from the model catalog — see the
full [API reference](https://imference.com/docs). The x402 rail (USDC on Base) is not
wrapped: it requires client-side wallet signing, out of scope for this server.

## Setup

```bash
npm install
npm run build
```

Requires Node.js ≥ 18.

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `IMFERENCE_API_KEY` | for generation tools | Bearer API key (top up credits at imference.com) |
| `IMFERENCE_BASE_URL` | – | API base URL (default `https://imference.com`) |

The catalog tools (`list_models`, `list_formats`) work without an API key.

## Usage with Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "imference": {
      "command": "node",
      "args": ["/path/to/imference-mcp/dist/index.js"],
      "env": {
        "IMFERENCE_API_KEY": "your-api-key"
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

1. Submits `POST /generate` — the model's catalog cost is deducted from your credits.
2. Polls `GET /status` with exponential backoff (2s → 10s) for up to `wait_seconds`
   (default 120). The API maps state to HTTP codes: `404` pending, `422` failed,
   `200` done.
3. Returns the blob URL of the media when done. If still running (videos can take a
   while), returns the `request_id` — poll it with `check_status`.

## Development

```bash
npm run dev   # tsc --watch
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
