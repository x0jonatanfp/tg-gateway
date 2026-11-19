# AGENTS.md

Guide for coding agents working in this repository.

## What this is

`tg-gateway` is an HTTP gateway for a Telegram bot: it receives updates via long-polling
(`getUpdates`), forwards them to external webhooks according to the command, and exposes an
internal HTTP API so those webhooks can respond (send messages, photos, videos, edit buttons,
etc.). It also downloads media (audio/video) from recognised URLs using `yt-dlp`.

It is a single-process service, with no database, meant to run as a system
systemd unit (`tg-gateway.service`) on its own host.

## Commands

```bash
pnpm dev              # run in development mode (tsx, no build)
pnpm build            # bundle to dist/tg-gateway.mjs with esbuild
pnpm test             # run the whole suite (vitest run)
pnpm test:watch       # vitest in watch mode
pnpm test:coverage    # vitest with coverage (v8)
```

A single test or file:

```bash
pnpm vitest run tests/application/handle-update.test.ts
pnpm vitest run -t "test name"
```

Deployment and operation (require access to the target host via `make`/`sudo systemctl`):

```bash
pnpm deploy   # make deploy: build + rsync to the deployment directory + reinstall prod + restart
pnpm restart  # sudo systemctl restart tg-gateway.service
pnpm status   # sudo systemctl status tg-gateway.service
pnpm logs     # journalctl -u tg-gateway.service -n 50 -f
```

There is no linter configured (neither ESLint nor Prettier); the code style is tabs for
indentation and strict TypeScript (`strict: true` in `tsconfig.json`). There is no separate
type-check build step — `tsc` does not run in CI; type checking happens implicitly
when running `tsx`/`esbuild` or when running the tests.

Package manager: **pnpm** (there is a `pnpm-lock.yaml`; do not use `npm`/`yarn`).

## Architecture

Hexagonal architecture (ports & adapters) in three layers under `src/`:

- **`domain/`** — pure logic, no I/O.
  - `entities/message.ts`: domain types (`OutgoingMessage`, `IncomingUpdate` with the
    real snake_case shape of Telegram, `SendResult`).
  - `ports/`: interfaces that infrastructure implements (`TelegramPort`,
    `HandlerRegistryPort`).
  - `services/queue.ts`: `QueueService`, a FIFO queue that serialises sends, respecting a
    minimum interval between messages (outbound rate limiting towards Telegram).
  - `services/transient-network.ts`: detection of transient network errors
    (`isTransientNetworkError`) and backoff with jitter (`backoffWithJitter`), shared
    by `telegram-client.ts` and `forwarder.ts` so the retry logic does not drift apart.

- **`application/`** — use cases, one per operation, all receive their dependencies
  (ports) through the constructor:
  - `send-message.ts`, `send-photo.ts`, `send-video.ts`, `edit-reply-markup.ts`: wrap
    the `TelegramPort` going through the `QueueService`.
  - `register-handler.ts`: add/list handlers in the `HandlerRegistryPort`.
  - `handle-update.ts` (`HandleUpdateUseCase`): the main router for incoming updates.
    Decision order in `execute()`: (1) `callback_query` → routes by `data` prefix;
    (2) text with a recognised media URL → `DownloadMediaUseCase`; (3) command (first
    token, with `@botname` trimmed) → registered handler; (4) fallback to the
    `__default__` handler if there is content (text, caption or any attachment). Forwards to the
    external webhook via `forwardUpdate`.
  - `download-media.ts` (`DownloadMediaUseCase`): detects URLs from supported platforms
    (YouTube, SoundCloud, Bandcamp, Vimeo, TikTok, Twitter/X, Instagram, Twitch, Spotify)
    with `MEDIA_URL_PATTERN`, and launches `yt-dlp` as a child process (fire-and-forget) with a
    cap on concurrent downloads (`TG_MAX_CONCURRENT_DOWNLOADS`). Other URLs (GitHub,
    docs, etc.) pass through to the handler registry.

- **`infrastructure/`** — concrete adapters and HTTP/process wiring:
  - `telegram-client.ts` (`TelegramClient implements TelegramPort`): HTTP client for the
    Telegram Bot API. It has retry with separate backoff for network errors (`net`) vs.
    429 rate-limiting (`rate`), per-method configurable timeouts, and a 3-state **circuit breaker**
    (`closed` → `open` → `half_open`) that cuts calls after N consecutive network failures so
    it does not hammer a downed endpoint. Multipart uploads (`sendPhoto`, `sendVideo`) are not
    retried by default, because a retry mid-upload can duplicate content on the server.
  - `poller.ts` (`Poller`): long-polling loop against `getUpdates`, with its own
    exponential backoff on errors (independent of the client's circuit breaker).
  - `forwarder.ts` (`forwardUpdate`): POSTs the update to the external webhook; it only retries
    on a transient network error, never on 4xx/5xx (the receiver may have partially processed it).
  - `handler-registry.ts` (`HandlerRegistry implements HandlerRegistryPort`): in-memory map
    `command → webhook` (not persisted; repopulated at boot from
    `TG_DEFAULT_HANDLERS` and then via `/api/register-handler`).
  - `api-server.ts` (`ApiServer`): Express with the internal endpoints (see below).
  - `config.ts` (`loadConfig`): all configuration comes from env vars, with defaults
    co-located in the module that uses them when that makes sense (e.g. the default timeouts
    per method live in `telegram-client.ts`, not in `config.ts`).
  - `logger.ts`: winston, text format to stdout + optional JSON to a file
    (`TG_LOG_FILE`).

`src/index.ts` is the composition root: it builds the undici `Agent` (forces IPv4 because the
host has no IPv6 egress — see the comment there for the exact reason), instantiates all the
use cases with their dependencies, starts `ApiServer` and the `Poller`, and filters updates by
allowed chat and by the bot's own messages.

That filter is the **only gatekeeper** of the system: it is the only door that opens to the internet. It is
closed by default — `TG_ALLOWED_CHATS` with an empty list (or undefined) **accepts no
update**, never "all"; startup warns about it with a `logger.warn`. The predicate lives in
`src/infrastructure/allowed-chat.ts` (`isAllowedChat`) and is therefore testable in
isolation: `index.ts` only calls it.

### Internal HTTP API (consumed by the external webhooks)

All under port `PORT` (default 4000):

- `GET /health`
- `POST /api/send`, `/api/send-photo`, `/api/send-video`, `/api/edit-reply-markup`,
  `/api/delete-message`, `/api/answer-callback`
- `POST /api/register-handler`, `GET /api/handlers`

### Testing conventions

- Tests in `tests/` (not next to the source code), mirroring the structure of `src/`.
- `tests/test/helpers.ts` has reusable mocks/builders: `createMockTelegramPort()`,
  `createMockHandlerRegistry()`, `createQueueService()`, `makeMessage()`/`makePhoto()`/
  `makeVideo()`. Reuse them instead of creating ad-hoc mocks.
  - When instantiating `TelegramClient` in tests, pass `retries: 0` so as not to depend on
    real backoff/timers.
- `tests/test/setup.ts` runs `vi.restoreAllMocks()` after each test (registered
  as a global `setupFiles` in `vitest.config.ts`).
- Coverage excludes `src/index.ts` (it is wiring, not logic testable in isolation).

### Non-obvious design notes

- The `QueueService` keeps a single promise chain per instance; if a task
  fails, the chain stays alive (`catch(() => {})`) so as not to block the following ones.
- The circuit breaker of `TelegramClient` is independent of the internal retry: the retry
  tries to recover from a short blip; the breaker prevents continuing to try when the pattern
  indicates a sustained outage.
- `isTransientNetworkError`/`backoffWithJitter` in `domain/services/transient-network.ts`
  are the only source of truth for "should I retry this?" — if a new network caller is added,
  use these functions instead of reimplementing the heuristic.
