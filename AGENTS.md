# AGENTS.md

Guía para agentes de código que trabajan en este repositorio.

## Qué es esto

`tg-gateway` es un gateway HTTP para un bot de Telegram: recibe updates vía long-polling
(`getUpdates`), los reenvía a webhooks externos según el comando, y expone una API HTTP
interna para que esos webhooks respondan (enviar mensajes, fotos, videos, editar botones,
etc.). También descarga medios (audio/video) de URLs reconocidas usando `yt-dlp`.

Es un servicio de un solo proceso, sin base de datos, pensado para correr como
unidad de sistema de systemd (`tg-gateway.service`) en un host propio.

## Comandos

```bash
pnpm dev              # correr en modo desarrollo (tsx, sin build)
pnpm build            # bundlear a dist/tg-gateway.mjs con esbuild
pnpm test             # correr toda la suite (vitest run)
pnpm test:watch       # vitest en modo watch
pnpm test:coverage    # vitest con cobertura (v8)
```

Un solo test o archivo:

```bash
pnpm vitest run tests/application/handle-update.test.ts
pnpm vitest run -t "nombre del test"
```

Deploy y operación (requieren acceso al host destino vía `make`/`sudo systemctl`):

```bash
pnpm deploy   # make deploy: build + rsync al directorio de despliegue + reinstall prod + restart
pnpm restart  # sudo systemctl restart tg-gateway.service
pnpm status   # sudo systemctl status tg-gateway.service
pnpm logs     # journalctl -u tg-gateway.service -n 50 -f
```

No hay linter configurado (ni ESLint ni Prettier); el estilo del código es tabs para
indentación y TypeScript estricto (`strict: true` en `tsconfig.json`). No hay build step
de tipo-check separado — `tsc` no corre en CI, la verificación de tipos ocurre implícitamente
al ejecutar `tsx`/`esbuild` o al correr los tests.

Gestor de paquetes: **pnpm** (hay `pnpm-lock.yaml`; no usar `npm`/`yarn`).

## Arquitectura

Arquitectura hexagonal (ports & adapters) en tres capas bajo `src/`:

- **`domain/`** — lógica pura, sin I/O.
  - `entities/message.ts`: tipos de dominio (`OutgoingMessage`, `IncomingUpdate` con el
    shape snake_case real de Telegram, `SendResult`).
  - `ports/`: interfaces que infraestructura implementa (`TelegramPort`,
    `HandlerRegistryPort`).
  - `services/queue.ts`: `QueueService`, cola FIFO que serializa envíos respetando un
    intervalo mínimo entre mensajes (rate limiting de salida hacia Telegram).
  - `services/transient-network.ts`: detección de errores de red transitorios
    (`isTransientNetworkError`) y backoff con jitter (`backoffWithJitter`), compartido
    por `telegram-client.ts` y `forwarder.ts` para no desincronizar la lógica de retry.

- **`application/`** — casos de uso, uno por operación, todos reciben sus dependencias
  (ports) por constructor:
  - `send-message.ts`, `send-photo.ts`, `send-video.ts`, `edit-reply-markup.ts`: wrappean
    al `TelegramPort` pasando por el `QueueService`.
  - `register-handler.ts`: alta/listado de handlers en el `HandlerRegistryPort`.
  - `handle-update.ts` (`HandleUpdateUseCase`): el router principal de updates entrantes.
    Orden de decisión en `execute()`: (1) `callback_query` → rutea por prefijo de `data`;
    (2) texto con URL de medio reconocida → `DownloadMediaUseCase`; (3) comando (primer
    token, con `@botname` recortado) → handler registrado; (4) fallback al handler
    `__default__` si hay contenido (texto, caption o cualquier adjunto). Reenvía al
    webhook externo vía `forwardUpdate`.
  - `download-media.ts` (`DownloadMediaUseCase`): detecta URLs de plataformas soportadas
    (YouTube, SoundCloud, Bandcamp, Vimeo, TikTok, Twitter/X, Instagram, Twitch, Spotify)
    con `MEDIA_URL_PATTERN`, y lanza `yt-dlp` como proceso hijo (fire-and-forget) con un
    cap de descargas concurrentes (`TG_MAX_CONCURRENT_DOWNLOADS`). Otras URLs (GitHub,
    docs, etc.) pasan de largo hacia el handler registry.

- **`infrastructure/`** — adapters concretos y wiring HTTP/proceso:
  - `telegram-client.ts` (`TelegramClient implements TelegramPort`): cliente HTTP a la
    Bot API de Telegram. Tiene retry con backoff separado para errores de red (`net`) vs.
    rate-limit 429 (`rate`), timeouts configurables por método, y un **circuit breaker**
    de 3 estados (`closed` → `open` → `half_open`) que corta llamadas tras N fallos
    consecutivos de red para no martillear un endpoint caído. Los multipart uploads
    (`sendPhoto`, `sendVideo`) no se reintentan por defecto porque un retry a mitad de
    subida puede duplicar contenido en el servidor.
  - `poller.ts` (`Poller`): loop de long-polling contra `getUpdates`, con backoff
    exponencial propio ante errores (independiente del circuit breaker del cliente).
  - `forwarder.ts` (`forwardUpdate`): hace el POST del update al webhook externo; solo
    reintenta ante error de red transitorio, nunca ante 4xx/5xx (el receptor pudo haber
    procesado parcialmente).
  - `handler-registry.ts` (`HandlerRegistry implements HandlerRegistryPort`): mapa en
    memoria `comando → webhook` (no persiste; se repuebla en boot desde
    `TG_DEFAULT_HANDLERS` y luego vía `/api/register-handler`).
  - `api-server.ts` (`ApiServer`): Express con los endpoints internos (ver abajo).
  - `config.ts` (`loadConfig`): toda la config sale de env vars, con defaults
    co-localizados en el módulo que los usa cuando tiene sentido (p. ej. los timeouts
    default por método viven en `telegram-client.ts`, no en `config.ts`).
  - `logger.ts`: winston, formato texto a stdout + JSON opcional a archivo
    (`TG_LOG_FILE`).

`src/index.ts` es el composition root: arma el `Agent` de undici (fuerza IPv4 porque el
host no tiene salida IPv6 — ver comentario ahí para el porqué exacto), instancia todos los
casos de uso con sus dependencias, arranca `ApiServer` y el `Poller`, y filtra updates por
chat permitido y por mensajes del propio bot.

Ese filtro es el **único portero** del sistema: es la única puerta que da a internet. Es
cerrado por defecto — `TG_ALLOWED_CHATS` con la lista vacía (o sin definir) **no acepta
ningún update**, nunca "todos"; el arranque lo avisa con un `logger.warn`. El predicado vive
en `src/infrastructure/allowed-chat.ts` (`isAllowedChat`) y por eso es testeable en
aislamiento: `index.ts` solo lo llama.

### API HTTP interna (consumida por los webhooks externos)

Todos bajo el puerto `PORT` (default 4000):

- `GET /health`
- `POST /api/send`, `/api/send-photo`, `/api/send-video`, `/api/edit-reply-markup`,
  `/api/delete-message`, `/api/answer-callback`
- `POST /api/register-handler`, `GET /api/handlers`

### Convenciones de testing

- Tests en `tests/` (no junto al código fuente), reflejando la estructura de `src/`.
- `tests/test/helpers.ts` tiene mocks/builders reusables: `createMockTelegramPort()`,
  `createMockHandlerRegistry()`, `createQueueService()`, `makeMessage()`/`makePhoto()`/
  `makeVideo()`. Reutilizarlos en vez de crear mocks ad-hoc.
  - Al instanciar `TelegramClient` en tests, pasar `retries: 0` para no depender de
    backoff/timers reales.
- `tests/test/setup.ts` corre `vi.restoreAllMocks()` después de cada test (registrado
  como `setupFiles` global en `vitest.config.ts`).
- Cobertura excluye `src/index.ts` (es wiring, no lógica testeable en aislamiento).

### Notas de diseño no obvias

- El `QueueService` mantiene una única cadena de promesas por instancia; si una tarea
  falla, la cadena sigue viva (`catch(() => {})`) para no bloquear las siguientes.
- El circuit breaker de `TelegramClient` es independiente del retry interno: el retry
  intenta recuperarse de un blip corto: el breaker previene seguir intentando cuando el
  patrón indica una caída sostenida.
- `isTransientNetworkError`/`backoffWithJitter` en `domain/services/transient-network.ts`
  son la única fuente de verdad para "¿reintento esto?" — si se agrega un nuevo caller
  de red, usar estas funciones en vez de reimplementar la heurística.
