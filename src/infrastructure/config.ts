import { logger } from "./logger.ts";

export interface AppConfig {
	tgToken: string;
	allowedChats: number[];
	pollTimeout: number;
	minIntervalMs: number;
	port: number;
	forwardTimeoutMs: number;
	apiTimeouts: Record<string, number>;
	forwardRetries: number;
	circuitBreakerThreshold: number;
	circuitBreakerCooldownMs: number;
	circuitBreakerHalfOpenMs: number;
	/**
	 * Cada cuánto un vigilante sondea Telegram cuando el breaker no está
	 * cerrado (ms). 0 lo desactiva.
	 */
	circuitWatchdogMs: number;
}

// Env vars per Telegram API method. Si no se definen, los defaults vive en
// el cliente (co-localizados con su uso). El config solo aporta overrides.
const API_TIMEOUT_ENV: Record<string, string> = {
	sendMessage: "TG_TIMEOUT_SEND_MESSAGE_MS",
	sendPhoto: "TG_TIMEOUT_SEND_PHOTO_MS",
	sendVideo: "TG_TIMEOUT_SEND_VIDEO_MS",
	editMessageReplyMarkup: "TG_TIMEOUT_EDIT_REPLY_MARKUP_MS",
	deleteMessage: "TG_TIMEOUT_DELETE_MESSAGE_MS",
	answerCallbackQuery: "TG_TIMEOUT_ANSWER_CALLBACK_QUERY_MS",
	getMe: "TG_TIMEOUT_GET_ME_MS",
};

export function loadConfig(): AppConfig {
	const tgToken = process.env.TG_BOT_TOKEN ?? "";
	if (!tgToken) {
		logger.warn("TG_BOT_TOKEN not configured - bot will not start");
	}

	return {
		tgToken,
		allowedChats: parseList(process.env.TG_ALLOWED_CHATS),
		pollTimeout: Number(process.env.TG_POLL_TIMEOUT ?? 30),
		minIntervalMs: Number(process.env.TG_MIN_INTERVAL_MS ?? 1200),
		port: Number(process.env.PORT ?? 4000),
		forwardTimeoutMs: parsePositiveMs(
			process.env.TG_TIMEOUT_FORWARD_MS,
			10_000,
		),
		apiTimeouts: loadApiTimeouts(),
		forwardRetries: parsePositiveMs(
			process.env.TG_FORWARD_RETRIES,
			0,
		),
		circuitBreakerThreshold: parsePositiveMs(
			process.env.TG_CIRCUIT_BREAKER_THRESHOLD,
			5,
		),
		// 30 s por defecto: suficiente para quel un pico corto de Telegram se
		// recupere sin necesidad de intervención; corto para no bloquear tráfico
		// legítimo cuando el endpoint eleva 429 reales por sobrecarga.
		circuitBreakerCooldownMs: parsePositiveMs(
			process.env.TG_CIRCUIT_BREAKER_COOLDOWN_MS,
			30_000,
		),
		// Caducidad de la prueba en half-open. Tiene que ser mayor que el
		// timeout de una llamada (15 s en los métodos JSON) para no relevar una
		// prueba que aún puede responder.
		circuitBreakerHalfOpenMs: parsePositiveMs(
			process.env.TG_CIRCUIT_BREAKER_HALF_OPEN_MS,
			20_000,
		),
		circuitWatchdogMs: parseNonNegativeMs(
			process.env.TG_CIRCUIT_WATCHDOG_MS,
			30_000,
		),
	};
}

function loadApiTimeouts(): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [method, envVar] of Object.entries(API_TIMEOUT_ENV)) {
		const v = process.env[envVar];
		if (v == null || v === "") continue;
		const n = Number(v);
		if (!Number.isFinite(n) || n <= 0) continue;
		out[method] = n;
	}
	return out;
}

// Parses a positive ms value or falls back to default. Empty/invalid → default.
// Un valor 0 sería "sin timeout" (peligroso, se cuelga), así que lo filtramos.
function parsePositiveMs(raw: string | undefined, fallback: number): number {
	if (raw == null || raw === "") return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return n;
}

/** Como parsePositiveMs pero admite 0 (para "desactivado"). */
function parseNonNegativeMs(raw: string | undefined, fallback: number): number {
	if (raw == null || raw === "") return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) return fallback;
	return n;
}

function parseList(raw?: string): number[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((s) => Number(s.trim()))
		.filter((n) => !isNaN(n));
}
