import dns from "node:dns";
import { setGlobalDispatcher, Agent } from "undici";
import { logger } from "./infrastructure/logger.ts";
import { redactWebhookCredentials } from "./infrastructure/redact.ts";
import { truncateLogText } from "./infrastructure/log-text.ts";
import { loadConfig } from "./infrastructure/config.ts";

// api.telegram.org publica registro A (IPv4) y AAAA (IPv6), pero este host no
// tiene salida IPv6: la ruta v6 falla al instante (EHOSTUNREACH). fetch/undici
// intentaba esa familia y devolvía "fetch failed" intermitente (el "Telégrafo
// que pierde la voz"). Forzamos IPv4 primero para usar siempre la ruta válida.
dns.setDefaultResultOrder("ipv4first");

// Conexiones a Telegram: IPv4-only + keepalive cada 10s + pool limpia cada 30s.
//
// api.telegram.org publica AAAA (IPv6), pero este host no tiene ruta IPv6:
// cada intento v6 devuelve ENETUNREACH. Incluso con ipv4first, el algoritmo
// Happy Eyeballs de undici 8 / Node 24 puede intentar las dos familias en
// paralelo. family:4 + autoSelectFamily:false lo fuerza a IPv4 siempre.
//
// El long-polling de /getUpdates deja el socket inactivo hasta ~30s. Si un
// middlebox (NAT, firewall) mata conexiones idle, undici las reintenta reusar
// de su pool interna (keepAliveMaxTimeout default 600s). Con 30s las evictamos
// rápido: cada poll cycle usa una conexión fresca o recién validada.
const agent = new Agent({
	connect: {
		keepAlive: true,
		keepAliveInitialDelay: 10_000,
		family: 4,
		autoSelectFamily: false,
	},
	keepAliveMaxTimeout: 30_000,
	connectTimeout: 15_000,
});
setGlobalDispatcher(agent);
import { TelegramClient } from "./infrastructure/telegram-client.ts";
import { Poller } from "./infrastructure/poller.ts";
import { HandlerRegistry } from "./infrastructure/handler-registry.ts";
import { ApiServer } from "./infrastructure/api-server.ts";
import { QueueService } from "./domain/services/queue.ts";
import { SendMessageUseCase } from "./application/send-message.ts";
import { SendPhotoUseCase } from "./application/send-photo.ts";
import { SendVideoUseCase } from "./application/send-video.ts";
import { SendMediaGroupUseCase } from "./application/send-media-group.ts";
import { EditReplyMarkupUseCase } from "./application/edit-reply-markup.ts";
import { HandleUpdateUseCase } from "./application/handle-update.ts";
import { RegisterHandlerUseCase } from "./application/register-handler.ts";
import { isAllowedChat } from "./infrastructure/allowed-chat.ts";

async function main() {
	const cfg = loadConfig();

	if (!cfg.tgToken) {
		logger.error(
			"TG_BOT_TOKEN not configured. Create .env with TG_BOT_TOKEN=...",
		);
		process.exit(1);
	}

	// Modo cerrado: sin chat permitido no entra nada. Que quede en el log, para
	// no confundir "gateway cerrado" con "gateway caído".
	if (cfg.allowedChats.length === 0) {
		logger.warn(
			"TG_ALLOWED_CHATS vacío: no se aceptará ningún update (gateway en modo cerrado)",
		);
	}

	const telegram = new TelegramClient(cfg.tgToken, {
		timeouts: cfg.apiTimeouts,
		circuitBreakerThreshold: cfg.circuitBreakerThreshold,
		circuitBreakerCooldownMs: cfg.circuitBreakerCooldownMs,
		circuitBreakerHalfOpenMs: cfg.circuitBreakerHalfOpenMs,
	});
	const handlerRegistry = new HandlerRegistry();
	const queue = new QueueService(cfg.minIntervalMs);

	const sendMessage = new SendMessageUseCase(telegram, queue);
	const sendPhoto = new SendPhotoUseCase(telegram, queue);
	const sendVideo = new SendVideoUseCase(telegram, queue);
	const sendMediaGroup = new SendMediaGroupUseCase(telegram, queue);
	const editReplyMarkup = new EditReplyMarkupUseCase(telegram, queue);
	const registerHandler = new RegisterHandlerUseCase(handlerRegistry);
	const handleUpdate = new HandleUpdateUseCase(handlerRegistry, {
		forwardTimeoutMs: cfg.forwardTimeoutMs,
		forwardRetries: cfg.forwardRetries,
	});

	const api = new ApiServer(
		cfg.port,
		sendMessage,
		sendPhoto,
		sendVideo,
		sendMediaGroup,
		editReplyMarkup,
		registerHandler,
		telegram,
		{
			info: () => telegram.breakerInfo(),
			probe: () => telegram.probeHealth(),
		},
	);
	api.start();

	// Vigilante del breaker: cuando no está cerrado, sondear Telegram con
	// getMe (que no envía nada a nadie) y cerrarlo en cuanto responda. Sin
	// esto, una caída de red de un minuto obligaba a reiniciar el servicio
	// (incidente del 30-sep-2026: ocho horas mudo hasta el reinicio manual).
	if (cfg.circuitWatchdogMs > 0) {
		let lastState = telegram.breakerInfo().state;
		const watchdog = setInterval(() => {
			if (telegram.breakerInfo().state === "closed") return;
			void telegram.probeHealth().then((result) => {
				if (result.state !== lastState) {
					lastState = result.state;
					logger.info("tg circuit watchdog", {
						state: result.state,
						ok: result.ok,
						error: result.error,
					});
				} else if (!result.ok) {
					logger.debug("tg circuit watchdog probe", {
						state: result.state,
						error: result.error,
					});
				}
			});
		}, cfg.circuitWatchdogMs);
		watchdog.unref();
	}

	const defaultHandlers = parseDefaultHandlers();
	for (const { command, webhook } of defaultHandlers) {
		handlerRegistry.register(command, webhook);
		logger.info("default handler registered", {
			command,
			webhook: redactWebhookCredentials(webhook),
		});
	}

	// Obtener ID del bot para ignorar mensajes enviados por sí mismo
	const botId = await telegram.getMe();
	if (botId) {
		logger.info("bot identified", { botId });
	}

	const poller = new Poller(
		{ token: cfg.tgToken, timeout: cfg.pollTimeout },
		async (update) => {
			// Ignorar mensajes enviados por el propio bot
			if (botId && update.message?.from?.id === botId) {
				return;
			}

			// Filtrar chats no permitidos
			const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
			if (!isAllowedChat(chatId, cfg.allowedChats)) {
				logger.debug("update from non-allowed chat", { chatId });
				return;
			}

			const cb = update.callback_query;
			if (cb) {
				telegram.answerCallbackQuery(cb.id).catch(() => {});
			}

			const handled = await handleUpdate.execute(update);
			if (!handled) {
				const txt = update.message?.text ?? "(no text)";
				logger.debug("unhandled update", {
					chat: update.message?.chat.id,
					text: truncateLogText(txt),
				});
			}
		},
	);

	await poller.start();
}

function parseDefaultHandlers(): Array<{ command: string; webhook: string }> {
	const raw = process.env.TG_DEFAULT_HANDLERS ?? "";
	if (!raw) return [];
	return raw.split(",").map((pair) => {
		const [command, webhook] = pair.split("=");
		return { command: command!, webhook: webhook! };
	});
}

main().catch((err) => {
	logger.error("fatal error", { error: String(err) });
	process.exit(1);
});
