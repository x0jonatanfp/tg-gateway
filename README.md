# tg-gateway

**One Telegram bot, one process, many services.** A small HTTP gateway that owns a
single bot token, long-polls Telegram and fans every update out to local webhooks —
one per command — so several unrelated scripts and tools can share the same bot.

[Español](README.es.md)

## Why a gateway

Telegram only allows **one** process to poll a bot token with `getUpdates`: a second
poller gets a `409 Conflict` and the two steal each other's updates. The usual fix is
to give every service its own bot, which means a new token, a new chat and a new set of
permissions for each one.

This gateway inverts that: one process owns the token and the allowlist, and everything
else talks to it over localhost. The benefits are boring but real:

- **One poller.** No `409`s, no duplicated updates, no per-service token.
- **One allowlist.** `TG_ALLOWED_CHATS` decides who can talk to the bot, and it is
  **closed by default**: with an empty or missing list nothing gets through, ever.
- **One rate limiter.** Sends are serialised with a minimum interval, so a burst of
  webhooks cannot get the bot flood-limited by Telegram.
- **Replies are symmetric.** Webhooks answer through the same HTTP API: send text,
  photos, albums, videos, edit buttons or delete a message.

## How it works

```
Telegram  ──getUpdates──▶  tg-gateway  ──POST update──▶  your webhook (/command)
                              ▲                              │
                              └────── POST /api/send ────────┘
```

1. `Poller` long-polls `getUpdates` and filters by allowed chat and by the bot's own
   messages.
2. `HandleUpdateUseCase` routes the update: a `callback_query` goes by its `data`
   prefix; a command (first token, `@botname` stripped) goes to the handler registered
   for it; anything else with content falls back to the `__default__` handler. A link
   to a video or audio platform is just text here, so it reaches your webhook like any
   other message.
3. The webhook processes it and replies with `POST /api/send` (or `/api/send-photo`,
   `/api/send-video`, `/api/send-media-group`, …) to the same process.

## Architecture

Hexagonal, three layers plus a composition root:

```
src/domain/          pure logic: entities, ports, the send queue, transient-error detection
src/application/     use cases, one per operation; dependencies injected as ports
src/infrastructure/  adapters: Telegram client, poller, forwarder, registry, Express API, config, logger
src/index.ts         composition root (wiring only)
src/mcp/             the MCP server, with the same layering, as a separate process
```

`src/mcp` does not import from `src/domain` or `src/infrastructure`: it is an HTTP
client of this same API, so it cannot bypass the queue, the retries or the circuit
breaker.

## Quick start

1. **Create the bot.** Talk to [@BotFather](https://t.me/BotFather), run `/newbot`,
   and copy the token it gives you.
2. **Configure.** Copy the template and fill in the token and your own chat id:

   ```bash
   cp .env.example .env
   ```

   ```dotenv
   TG_BOT_TOKEN=123456789:AA...your-token...
   TG_ALLOWED_CHATS=123456789
   ```

   `TG_ALLOWED_CHATS` is the only gate to the internet. Empty or unset means **no
   update is accepted** (the boot log warns about it). Send the bot a message and read
   your chat id from that warning, or from `GET /api/handlers` after registering a
   handler.
3. **Run it.**

   ```bash
   pnpm install
   pnpm dev
   ```

4. **Check it.**

   ```bash
   curl -s localhost:4000/health
   # {"ok":true,"alive":true,"uptime":12.3,...}
   ```

   `alive` means the process answers; `ok` means Telegram answers (it goes `false`
   while the circuit breaker is open).

Optional: register a handler so a command reaches your service.

```bash
curl -s localhost:4000/api/register-handler \
  -H 'content-type: application/json' \
  -d '{"command":"/deploy","webhook":"http://127.0.0.1:9000/hooks/deploy"}'
```

## HTTP API

All routes are on `PORT` (default `4000`) and the server binds **loopback only**: the
API has no authentication of its own, so it must never be reachable from the LAN.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/health` | `{ok, alive, uptime, breaker}`. No side effects. |
| `POST` | `/api/send` | Text message: `chat_id`, `text`, `parse_mode`, `reply_markup`. |
| `POST` | `/api/send-photo` | `chat_id`, `file_path`, `caption`, `reply_markup`. |
| `POST` | `/api/send-video` | `chat_id`, `file_path`, `caption`, `reply_markup`. |
| `POST` | `/api/send-media-group` | Album: `chat_id`, `file_paths` (2–10 photos), `caption`. |
| `POST` | `/api/edit-reply-markup` | `chat_id`, `message_id`, `reply_markup` (`{}` removes the buttons). |
| `POST` | `/api/delete-message` | `chat_id`, `message_id`. |
| `POST` | `/api/answer-callback` | `callback_query_id`, `text`. |
| `POST` | `/api/send-action` | Chat action (`typing`, …): `chat_id`, `action`. |
| `POST` | `/api/register-handler` | `command`, `webhook`. |
| `GET` | `/api/handlers` | Registered handlers, **with credentials redacted**. |

Fields are accepted in `snake_case` and `camelCase`. Responses are `{ok:true, result}`
on success; `502` means Telegram rejected the order (the body carries Telegram's own
description, truncated at 300 characters); `500` means the gateway itself failed. Every
response carries an `X-Request-Id`, and the caller may supply its own.

Handler webhooks are returned with the userinfo redacted (`http://***:***@host/path`):
a webhook may embed credentials, and `/api/handlers` is a diagnostic endpoint, not a
credential dump.

## The `tg-send` helper

`scripts/tg-send.mjs` is the same API for cron jobs and shell scripts, with no MCP and
no bot token of its own. It resolves the private chat itself and never prints it.

```bash
node dist/tg-send.mjs --status
node dist/tg-send.mjs --text "deploy finished"
node dist/tg-send.mjs --file /tmp/chart.png --type photo --caption "daily chart"
node dist/tg-send.mjs --files a.png b.png c.png --caption "three shots"
```

Text is HTML-escaped by default; `--html` and `--markdown` send it raw. `--url`
overrides the gateway base URL.

Where the chat id comes from, in order:

1. `--chat <id|@username>` if given.
2. `TG_ALLOWED_CHATS` in the `.env` next to the installation (override it with
   `TG_GATEWAY_ENV_FILE`) — first value of the list.
3. `TELEGRAM_CHAT_ID` in each file listed in `TG_CHAT_ID_ENV_FILES`
   (comma-separated), in order.

If none of them yields a value it fails closed instead of guessing.

## MCP server

`pnpm build` also produces `dist/tg-mcp.mjs`, a **stdio MCP server** with one tool,
`telegram`. It is another client of the HTTP API — it never talks to Telegram, holds no
token and does no polling.

| Action | Parameters | Limits |
|---|---|---|
| `status` | — | `/health` only; sends nothing. |
| `send_text` | `text`, `parse_mode` (`plain`/`html`/`markdown`), `chat` | 4096 chars; errors instead of truncating. |
| `send_photo` | `file_path`, `caption`, `chat` | `.jpg`, `.jpeg`, `.png`; caption ≤ 1024. |
| `send_video` | `file_path`, `caption`, `chat` | `.mp4`; caption ≤ 1024. |
| `send_album` | `file_paths` (2–10), `caption`, `chat` | 2–10 photos in one message. |
| `edit_buttons` | `message_id`, `reply_markup`, `chat` | Omitting `reply_markup` (or `{}`) removes the buttons. |
| `delete_message` | `message_id`, `chat` | Positive integer. |

Register it with your MCP client (paths are placeholders):

```bash
claude mcp add telegram -- node /opt/tg-gateway/dist/tg-mcp.mjs
```

```json
{
  "mcpServers": {
    "telegram": {
      "command": "node",
      "args": ["/opt/tg-gateway/dist/tg-mcp.mjs"],
      "env": {
        "TG_GATEWAY_URL": "http://127.0.0.1:4000"
      }
    }
  }
}
```

Destination resolution is `chat` argument > `TG_DEFAULT_CHAT_ID` > first value of
`TG_ALLOWED_CHATS` in the `.env` next to the installation (or wherever
`TG_GATEWAY_ENV_FILE` points). Set `TG_DEFAULT_CHAT_ID` when the MCP client's user
cannot read the gateway's env file.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `TG_BOT_TOKEN` | — | **Required.** Bot token from BotFather. |
| `TG_ALLOWED_CHATS` | *(empty)* | Comma-separated chat ids. Empty = reject every update. |
| `TG_DEFAULT_HANDLERS` | *(empty)* | `command=webhook,...` registered at boot. |
| `TG_POLL_TIMEOUT` | `30` | Long-poll timeout, seconds. |
| `TG_MIN_INTERVAL_MS` | `1200` | Minimum spacing between outgoing messages. |
| `PORT` | `4000` | HTTP API port (loopback only). |
| `TG_LOG_FILE` | *(stdout)* | JSON log file. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
| `TG_LOG_TEXT_CHARS` | `200` | Truncate message text in logs; `0` disables. |
| `TG_TIMEOUT_FORWARD_MS` | `10000` | Timeout for webhook forwarding. |
| `TG_FORWARD_RETRIES` | `0` | Retries for transient network errors on webhook POST. |
| `TG_CIRCUIT_BREAKER_THRESHOLD` | `5` | Consecutive network failures that open the breaker. |
| `TG_CIRCUIT_BREAKER_COOLDOWN_MS` | `30000` | How long it stays open. |
| `TG_CIRCUIT_BREAKER_HALF_OPEN_MS` | `20000` | Expiry of the half-open probe. |
| `TG_CIRCUIT_WATCHDOG_MS` | `30000` | Probe interval while the breaker is not closed; `0` disables. |
| `TG_TIMEOUT_SEND_MESSAGE_MS` | `15000` | Per-method override (also `_SEND_PHOTO_`, `_SEND_VIDEO_`, `_EDIT_REPLY_MARKUP_`, `_DELETE_MESSAGE_`, `_ANSWER_CALLBACK_QUERY_`, `_GET_ME_`). |
| `TG_GATEWAY_URL` | `http://127.0.0.1:4000` | Base URL used by the MCP server and `tg-send`. |
| `TG_GATEWAY_ENV_FILE` | `<install>/.env` | Overrides which env file the MCP server and `tg-send` read `TG_ALLOWED_CHATS` from (that key only). The default is resolved from the script's own path, never from the working directory. |
| `TG_DEFAULT_CHAT_ID` | — | Default chat for the MCP server; wins over the env file. |
| `TG_CHAT_ID_ENV_FILES` | *(empty)* | Extra env files `tg-send` reads `TELEGRAM_CHAT_ID` from. |

Rotate `TG_BOT_TOKEN` and any webhook token embedded in `TG_DEFAULT_HANDLERS` if they
ever end up in logs, tickets or a repository.

## Resilience

- **Send spacing.** `QueueService` keeps a single promise chain per process and waits
  `TG_MIN_INTERVAL_MS` between messages. A failed task does not break the chain.
- **Retries.** Only transient network errors are retried (`isTransientNetworkError`);
  a `4xx`/`5xx` from a webhook is never retried, because the receiver may have already
  processed part of it. Multipart uploads are not retried by default: a retry mid-upload
  can duplicate the media server-side.
- **Circuit breaker.** After `TG_CIRCUIT_BREAKER_THRESHOLD` consecutive network
  failures the client stops calling Telegram (`open`), then lets a single probe through
  (`half_open`). The watchdog reopens it with `getMe` as soon as Telegram answers, so a
  short outage does not need a restart. `/health` reports both the process (`alive`) and
  Telegram (`ok`).
- **Poller backoff.** The `getUpdates` loop has its own exponential backoff, independent
  of the breaker.
- **Redaction.** Webhook credentials are masked in logs and in `/api/handlers`; message
  text in logs is truncated to `TG_LOG_TEXT_CHARS`.

## Development

```bash
pnpm dev            # tsx, no build
pnpm build          # esbuild: dist/tg-gateway.mjs, dist/tg-mcp.mjs, dist/tg-send.mjs
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run
pnpm test:watch
pnpm test:coverage
```

Single file or single test:

```bash
pnpm vitest run tests/application/handle-update.test.ts
pnpm vitest run -t "nombre del test"
```

Tests live in `tests/`, mirroring `src/`. There is no linter: tabs, strict TypeScript,
and the existing conventions are the style guide. Package manager is **pnpm**.

## Deployment example

Build, copy `dist/` and the manifest to the install directory, then run it under
systemd. `deploy/tg-gateway.service.example` is a starting point:

`make deploy` does exactly that: builds, rsyncs `dist/` and the manifest to `DEST`
(default `/opt/$(NAME)`), reinstalls production dependencies there and restarts the
unit. Pick another destination per call with `make deploy DEST=/path`, or put
`DEST := …` in an untracked `local.mk` (it is in `.gitignore`) so your host's own
destination never ends up in the repository.

```ini
[Service]
Type=simple
User=tg-user
WorkingDirectory=/opt/tg-gateway
EnvironmentFile=-/etc/tg-gateway/tg-gateway.env
ExecStart=/usr/bin/node dist/tg-gateway.mjs
Restart=always
RestartSec=15
```

The real unit belongs in `/etc/systemd/system`, not in this repository. Secrets can be
injected with `EnvironmentFile=` or with whatever loader your host already uses.

For the application log, `copytruncate` keeps log rotation from needing a restart
(Winston holds the file descriptor open).

## License

MIT. See [LICENSE](LICENSE).
