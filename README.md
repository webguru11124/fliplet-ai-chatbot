# Fliplet AI Chatbot

AI chatbot that queries the [Fliplet REST API](https://developers.fliplet.com/REST-API-Documentation.html) through Claude tool calling. Ask natural-language questions about an app's data sources, entries, media folders, and files — the LLM decides which API calls to make, executes them, and synthesises the answer.

```
You ──► Node proxy ──► Claude (tool calling)
              │              │
              │◄─ tool reqs ─┘
              ▼
       Fliplet REST API
```

## What makes this different

- **Streaming** — the server exposes an SSE endpoint; the CLI prints tokens as they arrive instead of blocking on the full response.
- **Direct mode** — run `npm run chat:direct` to skip the server entirely and talk to Claude + Fliplet in-process. Handy for quick debugging.
- **Retry with backoff** — the Fliplet client retries on 429 / transient errors with exponential backoff (3 attempts).
- **Response truncation** — data sources with thousands of rows are capped at 50 entries before being sent to Claude, with metadata about the total count. This keeps token usage sane.
- **History trimming** — only the last 40 messages are sent to Claude, so long sessions don't blow up context or cost.
- **Zero extra CLI deps** — colors and spinner use raw ANSI escapes, no chalk/ora needed.

## Prerequisites

- **Node.js 18+** (uses built-in `fetch`)
- [Anthropic API key](https://console.anthropic.com/)
- [Fliplet API token](https://developers.fliplet.com/REST-API-Documentation.html) (Fliplet Studio → Organisation Settings → API tokens)
- A Fliplet **App ID**

## Setup

```bash
git clone <repo-url>
cd fliplet-ai-chatbot
npm install
cp .env.example .env   # then fill in the three values
```

## Usage

### Option A — Server + CLI (two terminals)

```bash
# Terminal 1: start the proxy
npm start

# Terminal 2: chat
npm run chat
```

### Option B — Direct mode (single terminal, no server)

```bash
npm run chat:direct
```

Both modes support the same conversation — ask about data sources, entries, files, app config:

```
You: What data sources does this app have?
  ↪ list_data_sources
Assistant: This app has 3 data sources: ...

You: Show me the first 5 rows of "Contacts"
  ↪ list_data_sources
  ↪ get_data_source_entries
Assistant: Here are the first 5 entries: ...

You: What files are uploaded?
  ↪ list_media_folders
  ↪ get_folder_files
Assistant: I found 12 files across 2 folders: ...
```

## API

### `POST /api/chat`

Standard request/response. Send `{ message, history }`, get `{ reply, history }`.

### `POST /api/chat/stream`

Same input, returns an SSE stream with `delta` (text chunks), `tool` (tool call notifications), and `done` events.

### `GET /health`

Returns `{ ok: true, appId }`.

## Tools the LLM can call

| Tool | Endpoint | Purpose |
|------|----------|---------|
| `get_app_info` | `GET /v1/apps/:id` | App metadata |
| `list_data_sources` | `GET /v1/data-sources?appId=` | All data sources |
| `get_data_source` | `GET /v1/data-sources/:id` | One data source detail |
| `get_data_source_entries` | `GET /v1/data-sources/:id/data` | Rows (auto-truncated) |
| `list_media_folders` | `GET /v1/media/folders?appId=` | Media folders |
| `get_folder_files` | `GET /v1/media/folders/:id/files` | Files in folder |
| `get_file_info` | `GET /v1/media/files/:id` | Single file metadata |

## Project structure

```
src/
  server.js       Express proxy — routes, SSE, agent loop
  cli.js          Terminal UI — streaming, direct mode, colors
  fliplet-api.js  Fliplet HTTP client — retry, truncation
  tools.js        Tool schemas + dispatcher (compact builder)
```
