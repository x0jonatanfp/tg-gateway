# tg-gateway

**Un bot de Telegram, un proceso, muchos servicios.** Un gateway HTTP pequeño que es
dueño de un único token, hace long-polling contra Telegram y reparte cada update a los
webhooks locales —uno por comando— para que varios scripts y herramientas compartan el
mismo bot.

[English](README.md)

## Por qué un gateway

Telegram solo deja que **un** proceso haga polling de un token con `getUpdates`: un
segundo poller recibe un `409 Conflict` y los dos se roban los updates entre sí. La
salida habitual es darle un bot a cada servicio, o sea un token nuevo, un chat nuevo y
un juego de permisos nuevo por cada uno.

Esto lo invierte: un solo proceso es dueño del token y de la lista de chats permitidos,
y todo lo demás habla con él por localhost. Las ventajas son aburridas pero reales:

- **Un poller.** Ni `409`, ni updates duplicados, ni un token por servicio.
- **Una lista de permitidos.** `TG_ALLOWED_CHATS` decide quién puede hablar con el bot,
  y es **cerrada por defecto**: con la lista vacía o sin definir no entra nada, nunca.
- **Un rate limiter.** Los envíos se serializan con un intervalo mínimo, así que una
  ráfaga de webhooks no consigue que Telegram limite al bot.
- **Las respuestas son simétricas.** Los webhooks contestan por la misma API HTTP:
  mandar texto, fotos, álbumes, vídeo, editar botones o borrar un mensaje.

## Cómo funciona

```
Telegram  ──getUpdates──▶  tg-gateway  ──POST update──▶  tu webhook (/comando)
                              ▲                              │
                              └────── POST /api/send ────────┘
```

1. `Poller` hace long-polling de `getUpdates` y filtra por chat permitido y por
   mensajes del propio bot.
2. `HandleUpdateUseCase` enruta el update: un `callback_query` va por el prefijo de su
   `data`; un comando (primer token, con `@botname` recortado) va al handler registrado
   para él; cualquier otra cosa con contenido cae al handler `__default__`. Un enlace a
   una plataforma de vídeo o audio es texto como cualquier otro: llega a tu webhook, no
   se intercepta.
3. El webhook lo procesa y contesta con `POST /api/send` (o `/api/send-photo`,
   `/api/send-video`, `/api/send-media-group`, …) al mismo proceso.

## Arquitectura

Hexagonal, tres capas y un composition root:

```
src/domain/          lógica pura: entidades, puertos, cola de envío, detección de errores transitorios
src/application/     casos de uso, uno por operación; dependencias inyectadas como puertos
src/infrastructure/  adaptadores: cliente de Telegram, poller, forwarder, registro, API Express, config, logger
src/index.ts         composition root (solo wiring)
src/mcp/             el servidor MCP, con las mismas capas, como proceso aparte
```

`src/mcp` no importa de `src/domain` ni de `src/infrastructure`: es un cliente HTTP de
esta misma API, así que no puede saltarse la cola, los reintentos ni el cortacircuitos.

## Quick start

1. **Crea el bot.** Habla con [@BotFather](https://t.me/BotFather), ejecuta `/newbot` y
   copia el token que te da.
2. **Configura.** Copia la plantilla y rellena el token y tu propio chat id:

   ```bash
   cp .env.example .env
   ```

   ```dotenv
   TG_BOT_TOKEN=123456789:AA...tu-token...
   TG_ALLOWED_CHATS=123456789
   ```

   `TG_ALLOWED_CHATS` es el único portero del sistema. Vacío o sin definir significa
   **no se acepta ningún update** (el arranque lo avisa en el log). Mándale un mensaje
   al bot y saca tu chat id de ese aviso, o de `GET /api/handlers` tras registrar un
   handler.
3. **Arranca.**

   ```bash
   pnpm install
   pnpm dev
   ```

4. **Comprueba.**

   ```bash
   curl -s localhost:4000/health
   # {"ok":true,"alive":true,"uptime":12.3,...}
   ```

   `alive` significa que el proceso contesta; `ok` significa que Telegram contesta (se
   pone en `false` mientras el cortacircuitos está abierto).

Opcional: registra un handler para que un comando llegue a tu servicio.

```bash
curl -s localhost:4000/api/register-handler \
  -H 'content-type: application/json' \
  -d '{"command":"/deploy","webhook":"http://127.0.0.1:9000/hooks/deploy"}'
```

## API HTTP

Todas las rutas van en `PORT` (default `4000`) y el servidor escucha **solo en
loopback**: la API no tiene autenticación propia, así que no debe ser alcanzable desde
la LAN.

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/health` | `{ok, alive, uptime, breaker}`. Sin efectos secundarios. |
| `POST` | `/api/send` | Texto: `chat_id`, `text`, `parse_mode`, `reply_markup`. |
| `POST` | `/api/send-photo` | `chat_id`, `file_path`, `caption`, `reply_markup`. |
| `POST` | `/api/send-video` | `chat_id`, `file_path`, `caption`, `reply_markup`. |
| `POST` | `/api/send-media-group` | Álbum: `chat_id`, `file_paths` (2–10 fotos), `caption`. |
| `POST` | `/api/edit-reply-markup` | `chat_id`, `message_id`, `reply_markup` (`{}` quita los botones). |
| `POST` | `/api/delete-message` | `chat_id`, `message_id`. |
| `POST` | `/api/answer-callback` | `callback_query_id`, `text`. |
| `POST` | `/api/send-action` | Acción de chat (`typing`, …): `chat_id`, `action`. |
| `POST` | `/api/register-handler` | `command`, `webhook`. |
| `GET` | `/api/handlers` | Handlers registrados, **con las credenciales redactadas**. |

Los campos se aceptan en `snake_case` y `camelCase`. Las respuestas son
`{ok:true, result}` si va bien; `502` significa que Telegram rechazó la orden (el cuerpo
lleva la descripción de Telegram, recortada a 300 caracteres); `500` significa que falló
el gateway. Toda respuesta lleva un `X-Request-Id`, y quien llama puede aportar el suyo.

Los webhooks se devuelven con el userinfo redactado (`http://***:***@host/ruta`): un
webhook puede llevar credenciales y `/api/handlers` es un endpoint de diagnóstico, no un
vertedero de credenciales.

## El helper `tg-send`

`scripts/tg-send.mjs` es la misma API para crons y scripts de shell, sin MCP y sin token
del bot propio. Resuelve el chat privado solo y no lo imprime nunca.

```bash
node dist/tg-send.mjs --status
node dist/tg-send.mjs --text "deploy finished"
node dist/tg-send.mjs --file /tmp/chart.png --type photo --caption "daily chart"
node dist/tg-send.mjs --files a.png b.png c.png --caption "three shots"
```

El texto va escapado a HTML por defecto; `--html` y `--markdown` lo mandan tal cual.
`--url` pisa la URL base del gateway.

De dónde sale el chat id, por orden:

1. `--chat <id|@usuario>` si se pasa.
2. `TG_ALLOWED_CHATS` en el `.env` situado junto a la instalación (se puede cambiar
   con `TG_GATEWAY_ENV_FILE`) — el primer valor de la lista.
3. `TELEGRAM_CHAT_ID` en cada fichero listado en `TG_CHAT_ID_ENV_FILES` (separados por
   comas), en orden.

Si ninguna fuente da un valor, falla cerrado en vez de adivinar.

## Servidor MCP

`pnpm build` produce también `dist/tg-mcp.mjs`, un **servidor MCP por stdio** con una
sola tool, `telegram`. Es otro cliente de la API HTTP: no habla con Telegram, no guarda
el token y no hace polling.

| Acción | Parámetros | Límites |
|---|---|---|
| `status` | — | Solo `/health`; no envía nada. |
| `send_text` | `text`, `parse_mode` (`plain`/`html`/`markdown`), `chat` | 4096 caracteres; da error en vez de truncar. |
| `send_photo` | `file_path`, `caption`, `chat` | `.jpg`, `.jpeg`, `.png`; caption ≤ 1024. |
| `send_video` | `file_path`, `caption`, `chat` | `.mp4`; caption ≤ 1024. |
| `send_album` | `file_paths` (2–10), `caption`, `chat` | 2–10 fotos en un solo mensaje. |
| `edit_buttons` | `message_id`, `reply_markup`, `chat` | Sin `reply_markup` (o con `{}`) quita los botones. |
| `delete_message` | `message_id`, `chat` | Entero positivo. |

Regístralo en tu cliente MCP (las rutas son placeholders):

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

El destino se resuelve como `chat` de la llamada > `TG_DEFAULT_CHAT_ID` > primer valor
de `TG_ALLOWED_CHATS` en el `.env` situado junto a la instalación (o donde apunte
`TG_GATEWAY_ENV_FILE`). Define `TG_DEFAULT_CHAT_ID` cuando el usuario del cliente MCP
no pueda leer el env file del gateway.

## Variables de entorno

| Variable | Default | Qué es |
|---|---|---|
| `TG_BOT_TOKEN` | — | **Obligatoria.** Token del bot de BotFather. |
| `TG_ALLOWED_CHATS` | *(vacío)* | Chat ids separados por comas. Vacío = rechaza todos los updates. |
| `TG_DEFAULT_HANDLERS` | *(vacío)* | `comando=webhook,...` registrados al arrancar. |
| `TG_POLL_TIMEOUT` | `30` | Timeout del long polling, en segundos. |
| `TG_MIN_INTERVAL_MS` | `1200` | Separación mínima entre mensajes salientes. |
| `PORT` | `4000` | Puerto de la API HTTP (solo loopback). |
| `TG_LOG_FILE` | *(stdout)* | Fichero de log JSON. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
| `TG_LOG_TEXT_CHARS` | `200` | Recorta el texto de los mensajes en logs; `0` lo desactiva. |
| `TG_TIMEOUT_FORWARD_MS` | `10000` | Timeout del reenvío a webhooks. |
| `TG_FORWARD_RETRIES` | `0` | Reintentos ante error de red transitorio al reenviar. |
| `TG_CIRCUIT_BREAKER_THRESHOLD` | `5` | Fallos de red consecutivos que abren el breaker. |
| `TG_CIRCUIT_BREAKER_COOLDOWN_MS` | `30000` | Cuánto permanece abierto. |
| `TG_CIRCUIT_BREAKER_HALF_OPEN_MS` | `20000` | Caducidad de la prueba en half-open. |
| `TG_CIRCUIT_WATCHDOG_MS` | `30000` | Intervalo de sondeo mientras el breaker no está cerrado; `0` lo desactiva. |
| `TG_TIMEOUT_SEND_MESSAGE_MS` | `15000` | Override por método (también `_SEND_PHOTO_`, `_SEND_VIDEO_`, `_EDIT_REPLY_MARKUP_`, `_DELETE_MESSAGE_`, `_ANSWER_CALLBACK_QUERY_`, `_GET_ME_`). |
| `TG_GATEWAY_URL` | `http://127.0.0.1:4000` | URL base que usan el servidor MCP y `tg-send`. |
| `TG_GATEWAY_ENV_FILE` | `<install>/.env` | Cambia el fichero del que el MCP y `tg-send` leen `TG_ALLOWED_CHATS` (solo esa clave). El default se calcula desde la ruta del propio script, nunca desde el directorio de trabajo. |
| `TG_DEFAULT_CHAT_ID` | — | Chat por defecto del MCP; tiene prioridad sobre el fichero. |
| `TG_CHAT_ID_ENV_FILES` | *(vacío)* | Env files extra de los que `tg-send` lee `TELEGRAM_CHAT_ID`. |

Rota `TG_BOT_TOKEN` y cualquier token de webhook embebido en `TG_DEFAULT_HANDLERS` si
acaban en logs, en un ticket o en un repositorio.

## Resiliencia

- **Espaciado de envíos.** `QueueService` mantiene una única cadena de promesas por
  proceso y espera `TG_MIN_INTERVAL_MS` entre mensajes. Una tarea fallida no rompe la
  cadena.
- **Reintentos.** Solo se reintentan los errores de red transitorios
  (`isTransientNetworkError`); un `4xx`/`5xx` de un webhook no se reintenta nunca,
  porque el receptor puede haber procesado ya parte del update. Los multipart no se
  reintentan por defecto: un reintento a mitad de subida puede duplicar el medio.
- **Cortacircuitos.** Tras `TG_CIRCUIT_BREAKER_THRESHOLD` fallos de red consecutivos el
  cliente deja de llamar a Telegram (`open`) y luego deja pasar una sola prueba
  (`half_open`). El vigilante lo vuelve a cerrar con `getMe` en cuanto Telegram
  responde, así que un corte corto no necesita reinicio. `/health` informa del proceso
  (`alive`) y de Telegram (`ok`).
- **Backoff del poller.** El bucle de `getUpdates` tiene su propio backoff exponencial,
  independiente del breaker.
- **Redacción.** Las credenciales de los webhooks se enmascaran en logs y en
  `/api/handlers`; el texto de los mensajes se recorta a `TG_LOG_TEXT_CHARS`.

## Desarrollo

```bash
pnpm dev            # tsx, sin build
pnpm build          # esbuild: dist/tg-gateway.mjs, dist/tg-mcp.mjs, dist/tg-send.mjs
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run
pnpm test:watch
pnpm test:coverage
```

Un solo fichero o un solo test:

```bash
pnpm vitest run tests/application/handle-update.test.ts
pnpm vitest run -t "nombre del test"
```

Los tests viven en `tests/`, replicando `src/`. No hay linter: tabulaciones, TypeScript
estricto y las convenciones que ya hay son la guía de estilo. El gestor de paquetes es
**pnpm**.

## Ejemplo de despliegue

Construye, copia `dist/` y el manifiesto al directorio de instalación y ejecútalo bajo
systemd. `deploy/tg-gateway.service.example` es un punto de partida:

`make deploy` hace justo eso: construye, copia `dist/` y el manifiesto a `DEST`
(por defecto `/opt/$(NAME)`), reinstala ahí las dependencias de producción y reinicia
la unidad. Cambia el destino por llamada con `make deploy DEST=/ruta`, o pon
`DEST := …` en un `local.mk` sin versionar (está en `.gitignore`) para que el destino
de tu host no acabe en el repositorio.

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

La unidad real va en `/etc/systemd/system`, no en este repositorio. Los secretos se
pueden inyectar con `EnvironmentFile=` o con el lanzador que ya use tu host.

Para el log de la aplicación, `copytruncate` evita que la rotación necesite un reinicio
(Winston mantiene abierto el descriptor del fichero).

## Licencia

MIT. Ver [LICENSE](LICENSE).
