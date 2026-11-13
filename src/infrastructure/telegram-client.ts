import { logger } from "./logger.ts";
import { truncateLogText } from "./log-text.ts";
import type {
	OutgoingMediaGroup,
	OutgoingMessage,
	OutgoingPhoto,
	OutgoingVideo,
	SendResult,
	TelegramOperationResult,
} from "../domain/entities/message.ts";
import type { TelegramPort } from "../domain/ports/telegram.ts";
import {
	backoffWithJitter,
	isTransientNetworkError,
} from "../domain/services/transient-network.ts";

// `String(err)` de un fallo de fetch da "TypeError: fetch failed" y esconde la
// causa real. Expone el errno subyacente (e.cause.code) para poder diagnosticar.
function errInfo(err: unknown): { error: string; cause?: string } {
	const e = err as Error & { cause?: { code?: string; message?: string } };
	return { error: String(err), cause: e?.cause?.code ?? e?.cause?.message };
}

// Timeouts por método (ms). Las llamadas JSON son rápidas y la API suele
// responder en pocos cientos de ms; los multipart (foto/video) viajan
// archivos enteros y merecen más margen.
const METHOD_TIMEOUTS_MS: Record<string, number> = {
	sendMessage: 15_000,
	sendPhoto: 60_000,
	sendVideo: 60_000,
	sendMediaGroup: 90_000,
	editMessageReplyMarkup: 15_000,
	deleteMessage: 15_000,
	answerCallbackQuery: 10_000,
	getMe: 10_000,
};

const MAX_RATE_LIMIT_ATTEMPTS = 3;

/**
 * Descripción del rechazo de Telegram (`{ok:false, description}`) para poder
 * devolverla al llamador. Antes estas dos operaciones la tiraban.
 */
async function telegramError(res: Response): Promise<string> {
	const body = await res.text().catch(() => "");
	let description: string | undefined;
	try {
		const parsed = JSON.parse(body) as { description?: unknown };
		if (typeof parsed.description === "string") description = parsed.description;
	} catch {
		// Cuerpo no JSON: se usa el texto crudo recortado.
	}
	const text = (description ?? body).slice(0, 300).trim();
	return text === "" ? `HTTP ${res.status}` : text;
}

// Circuit breaker: cuando el endpoint de Telegram acumula N fallos consecutivos de
// red (salidas que terminan en throw después de agotar los retries internos),
// dejamos de pegarle durante un cooldown. Al expirar, permitimos UNA llamada de
// prueba (half-open). Si esa pasa, cerramos; si falla, reabrimos y reiniciamos el
// cooldown. Esto evita martillear un host caído y llena los logs de ruido.
type BreakerState = "closed" | "open" | "half_open";

class CircuitBreakerOpenError extends Error {
	constructor() {
		super("tg circuit breaker open");
		this.name = "CircuitBreakerOpenError";
	}
}

export interface TelegramClientOptions {
	/**
	 * Reintentos ante errores de red transitorios (default 3).
	 * Poner 0 para deshabilitar (útil en tests que mockean fetch).
	 */
	retries?: number;
	/**
	 * Métodos que NO se reintentan automáticamente. Por defecto, los
	 * multipart uploads (sendPhoto, sendVideo): un fallo a mitad del body
	 * puede haber dejado bytes en el servidor y un retry produce
	 * duplicados. `sendMessage` y compañía sí reintentan porque el body
	 * es pequeño y entra en un solo paquete TCP.
	 */
	noRetryMethods?: string[];
	/**
	 * Overrides de timeout por método (ms). Si una clave está presente,
	 * se usa en lugar del default del mapa interno. Las claves válidas
	 * son las del mapa METHOD_TIMEOUTS_MS. Típicamente poblado desde
	 * `cfg.apiTimeouts` (env vars TG_TIMEOUT_*_MS).
	 */
	timeouts?: Partial<Record<string, number>>;
	/**
	 * Fallos consecutivos de red (post-retries) que disparan el circuit
	 * breaker. Default 5 — suficiente para absorber un blip corto y
	 * suficiente para detectar outages reales.
	 */
	circuitBreakerThreshold?: number;
	/**
	 * Tiempo de pausa cuando el breaker abre (ms). Default 30_000.
	 */
	circuitBreakerCooldownMs?: number;
	/**
	 * Caducidad de la llamada de prueba en half-open (ms). Default 20_000.
	 *
	 * Sin esto, una prueba que se queda colgada (o que falla y su reintento ve
	 * la prueba "en vuelo") deja el breaker atascado en half_open para siempre:
	 * todas las llamadas siguientes se rechazan, sin red y sin recuperación.
	 * Pasado este plazo, otra llamada puede tomar el relevo como prueba.
	 */
	circuitBreakerHalfOpenMs?: number;
}

export class TelegramClient implements TelegramPort {
	private apiBase: string;
	private networkRetries: number;
	private noRetryMethods: Set<string>;
	private timeouts: Partial<Record<string, number>>;
	private cbThreshold: number;
	private cbCooldownMs: number;
	private cbHalfOpenMs: number;
	private breaker: {
		state: BreakerState;
		failures: number;
		openedAt: number;
		probeInFlight: boolean;
		probeStartedAt: number;
	} = {
		state: "closed",
		failures: 0,
		openedAt: 0,
		probeInFlight: false,
		probeStartedAt: 0,
	};

	constructor(token: string, options: TelegramClientOptions = {}) {
		this.apiBase = `https://api.telegram.org/bot${token}`;
		this.networkRetries = options.retries ?? 3;
		this.noRetryMethods = new Set(
			options.noRetryMethods ?? ["sendPhoto", "sendVideo", "sendMediaGroup"],
		);
		this.timeouts = options.timeouts ?? {};
		this.cbThreshold = options.circuitBreakerThreshold ?? 5;
		this.cbCooldownMs = options.circuitBreakerCooldownMs ?? 30_000;
		this.cbHalfOpenMs = options.circuitBreakerHalfOpenMs ?? 20_000;
	}

	// Sincrónica. Antes de cada fetch: si el breaker está abierto y dentro del
	// cooldown, lanza. Si está abierto y el cooldown expiró, transiciona a
	// half-open y permite UNA llamada. Si está half-open y otra llamada entra
	// antes de que la primera resuelva, la bloquea.
	private beforeAttempt(): void {
		if (this.breaker.state === "open") {
			if (Date.now() - this.breaker.openedAt < this.cbCooldownMs) {
				throw new CircuitBreakerOpenError();
			}
			this.breaker.state = "half_open";
			this.breaker.probeInFlight = false;
		} else if (
			this.breaker.state === "half_open" &&
			this.breaker.probeInFlight
		) {
			// Hay una prueba en vuelo: el resto se rechaza... salvo que lleve
			// demasiado tiempo y haga falta relevarla.
			const ageMs = Date.now() - this.breaker.probeStartedAt;
			if (ageMs <= this.cbHalfOpenMs) {
				throw new CircuitBreakerOpenError();
			}
			logger.warn("tg circuit breaker probe lease expired", {
				ageMs,
				leaseMs: this.cbHalfOpenMs,
			});
			this.breaker.probeInFlight = false;
		}

		if (this.breaker.state === "half_open") {
			this.breaker.probeInFlight = true;
			this.breaker.probeStartedAt = Date.now();
		}
	}

	// Cualquier respuesta (4xx, 5xx, 429 incluido) significa que la red está
	// sana: el endpoint responde. Reset contador.
	private recordSuccess(): void {
		// Sólo logueamos la transición (closed/hit limit → recovering). Llamarlo
		// en cada éxito es ruido innecesario.
		if (this.breaker.state !== "closed") {
			logger.debug("tg circuit breaker closed", {
				previousState: this.breaker.state,
				previousFailures: this.breaker.failures,
			});
		}
		this.breaker.state = "closed";
		this.breaker.failures = 0;
		this.breaker.probeInFlight = false;
	}

	// Llamada por catch cuando los retries internos se agotaron y el error es
	// transitorio. Cualquier fallo en half-open reabre; en closed incrementa
	// hasta el threshold. Si ya estaba open, no tocamos el contador.
	private recordFailure(): void {
		if (this.breaker.state === "open") return;
		this.breaker.failures++;
		const shouldTrip =
			this.breaker.state === "half_open" ||
			this.breaker.failures >= this.cbThreshold;
		if (shouldTrip) {
			const previousState = this.breaker.state;
			this.breaker.state = "open";
			this.breaker.openedAt = Date.now();
			this.breaker.probeInFlight = false;
			logger.warn("tg circuit breaker opened", {
				failures: this.breaker.failures,
				previousState,
			});
		}
	}

	private logOperation(
		method: string,
		chatId: string | undefined,
		startedAt: number,
		ok: boolean,
		messageId?: number,
		text?: string,
		textField: "text" | "caption" = "text",
	): void {
		const meta: Record<string, unknown> = {
			method,
			ok,
			ms: Math.round(performance.now() - startedAt),
		};
		if (chatId !== undefined) meta.chatId = chatId;
		if (messageId !== undefined) meta.messageId = messageId;
		const loggedText = truncateLogText(text);
		if (loggedText !== undefined) meta[textField] = loggedText;
		if (ok) logger.info("telegram send", meta);
		else logger.warn("telegram send", meta);
	}

	private timeoutFor(method: string): number {
		return this.timeouts[method] ?? METHOD_TIMEOUTS_MS[method] ?? 15_000;
	}

	/** Estado del circuit breaker, para /health y para los vigilantes. */
	breakerInfo(): {
		state: BreakerState;
		failures: number;
		openedAt: number;
		probeInFlight: boolean;
		cooldownMs: number;
		halfOpenMs: number;
	} {
		return {
			state: this.breaker.state,
			failures: this.breaker.failures,
			openedAt: this.breaker.openedAt,
			probeInFlight: this.breaker.probeInFlight,
			cooldownMs: this.cbCooldownMs,
			halfOpenMs: this.cbHalfOpenMs,
		};
	}

	/**
	 * Sonda barata (getMe, no envía nada a nadie) para que un vigilante pueda
	 * cerrar el breaker en cuanto Telegram vuelva. Respeta el breaker: si está
	 * dentro del cooldown devuelve ok:false sin tocar la red.
	 */
	async probeHealth(): Promise<{
		ok: boolean;
		state: BreakerState;
		error?: string;
	}> {
		try {
			this.beforeAttempt();
		} catch (err) {
			return { ok: false, state: this.breaker.state, error: String(err) };
		}
		try {
			const res = await fetch(`${this.apiBase}/getMe`, {
				method: "POST",
				signal: AbortSignal.timeout(this.timeoutFor("getMe")),
			});
			this.recordSuccess();
			return { ok: res.ok, state: this.breaker.state };
		} catch (err) {
			if (this.breaker.state === "half_open") {
				this.breaker.probeInFlight = false;
			}
			this.recordFailure();
			return { ok: false, state: this.breaker.state, error: String(err) };
		}
	}

	// tgFetch maneja dos dimensiones de retry en contadores separados:
	//  - `rate` para 429 (llegó respuesta, el servidor nos rate-limita)
	//  - `net`  para errores de red transitorios (ni siquiera obtuvimos
	//           respuesta, así que reenviar es seguro para métodos con
	//           body chico; para multipart ver noRetryMethods).
	// No se mezclan en un mismo contador porque tienen semánticas muy
	// distintas: si obtuvimos respuesta, los bytes llegaron enteros.
	private async tgFetch(
		method: string,
		init: RequestInit,
		counter: { rate: number; net: number } = { rate: 0, net: 0 },
	): Promise<Response> {
		while (true) {
			this.beforeAttempt();
			try {
				const res = await fetch(`${this.apiBase}/${method}`, {
					...init,
					signal: AbortSignal.timeout(this.timeoutFor(method)),
				});
				this.recordSuccess();

				if (res.status === 429 && counter.rate < MAX_RATE_LIMIT_ATTEMPTS) {
					const body = (await res.json().catch(() => ({}))) as {
						parameters?: { retry_after?: number };
					};
					const retryAfter = Number(body?.parameters?.retry_after ?? 1);
					const level = counter.rate === 0 ? "warn" : "debug";
					logger[level]("rate limited by Telegram", {
						method,
						retryAfter,
						attempt: counter.rate + 1,
					});
					await new Promise((r) => setTimeout(r, (retryAfter + 0.5) * 1000));
					// Resetear `net` porque esta rama sí recibió respuesta.
					return this.tgFetch(method, init, {
						rate: counter.rate + 1,
						net: 0,
					});
				}
				return res;
			} catch (err) {
				// Si esta llamada era la prueba de half-open, ha terminado:
				// liberamos el relevo. Sin esto, el reintento veía la prueba
				// "en vuelo", lanzaba CircuitBreakerOpenError y el breaker se
				// quedaba en half_open para siempre (incidente del 30-sep-2026:
				// ocho horas con Telegram mudo).
				if (this.breaker.state === "half_open") {
					this.breaker.probeInFlight = false;
				}
				// El breaker es un error de nuestra propia decisión, no de la red:
				// no cuenta como fallo para el breaker y no entra en la lógica de
				// retry. Sale inmediatamente.
				if (err instanceof CircuitBreakerOpenError) {
					throw err;
				}

				const nonTransient = !isTransientNetworkError(err);
				const exhausted =
					counter.net >= this.networkRetries ||
					this.noRetryMethods.has(method);
				if (exhausted || nonTransient) {
					if (exhausted) this.recordFailure();
					throw err;
				}
				const delay = backoffWithJitter(counter.net);
				const level = counter.net === 0 ? "warn" : "debug";
				logger[level]("tgFetch network retry", {
					method,
					attempt: counter.net + 1,
					delay,
					...errInfo(err),
				});
				await new Promise((r) => setTimeout(r, delay));
				counter = { rate: counter.rate, net: counter.net + 1 };
			}
		}
	}

	async sendMessage(msg: OutgoingMessage): Promise<SendResult | null> {
		const startedAt = performance.now();
		const body: Record<string, unknown> = {
			chat_id: msg.chatId,
			text: msg.text,
			parse_mode: msg.parseMode ?? "Markdown",
		};
		if (msg.replyMarkup) body.reply_markup = msg.replyMarkup;

		try {
			let res = await this.tgFetch("sendMessage", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const reason = await res.text().catch(() => "");
				const esErrorDeFormato = /parse|entit/i.test(reason);
				if (!esErrorDeFormato) {
					// No es un problema de Markdown (p. ej. "chat not found",
					// token inválido): reintentar sin parse_mode no arregla nada.
					logger.warn("sendMessage falló (sin fallback)", {
						parseMode: body.parse_mode,
						status: res.status,
						reason: reason.slice(0, 200),
						text: String(msg.text).slice(0, 120),
					});
					this.logOperation("sendMessage", msg.chatId, startedAt, false, undefined, msg.text);
					return null;
				}
				// Telegram rechazó el formato. Reintentamos en crudo para no
				// perder el mensaje, pero dejamos constancia: el texto llegará
				// con las etiquetas visibles y eso es un bug de quien lo compuso.
				logger.warn("sendMessage parse_mode fallback", {
					parseMode: body.parse_mode,
					status: res.status,
					reason: reason.slice(0, 200),
					text: String(msg.text).slice(0, 120),
				});
				body.parse_mode = undefined;
				res = await this.tgFetch("sendMessage", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
				if (!res.ok) {
					const reason2 = await res.text().catch(() => "");
					logger.warn("sendMessage fallback falló", {
						status: res.status,
						reason: reason2.slice(0, 200),
						text: String(msg.text).slice(0, 120),
					});
					this.logOperation("sendMessage", msg.chatId, startedAt, false, undefined, msg.text);
					return null;
				}
			}
			const raw = await res.json();
			const result = this.parseResult(raw);
			this.logOperation(
				"sendMessage",
				msg.chatId,
				startedAt,
				result !== null,
				result?.messageId,
				msg.text,
			);
			return result;
		} catch (err) {
			logger.error("sendMessage failed", errInfo(err));
			this.logOperation("sendMessage", msg.chatId, startedAt, false, undefined, msg.text);
			return null;
		}
	}

	async sendPhoto(
		photo: OutgoingPhoto,
		caption?: string,
	): Promise<SendResult | null> {
		const startedAt = performance.now();
		try {
			const { readFile } = await import("node:fs/promises");
			const data = await readFile(photo.filePath);
			const ext = photo.filePath.endsWith(".jpg") ||
				photo.filePath.endsWith(".jpeg")
				? "image/jpeg"
				: "image/png";
			const boundary = `----boundary${Date.now()}`;
			let body = "";
			body +=
				`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${photo.chatId}\r\n`;
			if (caption) {
				body +=
					`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`;
			}
			if (photo.replyMarkup) {
				body +=
					`--${boundary}\r\nContent-Disposition: form-data; name="reply_markup"\r\n\r\n${JSON.stringify(photo.replyMarkup)}\r\n`;
			}
			body +=
				`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="photo.${ext === "image/jpeg" ? "jpg" : "png"}"\r\nContent-Type: ${ext}\r\n\r\n`;
			const buf = Buffer.from(body, "utf-8");
			const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
			const payload = Buffer.concat([buf, data, footer]);

			const res = await this.tgFetch("sendPhoto", {
				method: "POST",
				headers: {
					"Content-Type": `multipart/form-data; boundary=${boundary}`,
					"Content-Length": String(payload.length),
				},
				body: payload,
			});
			if (!res.ok) {
				this.logOperation("sendPhoto", photo.chatId, startedAt, false, undefined, caption, "caption");
				return null;
			}
			const raw = await res.json();
			const result = this.parseResult(raw);
			this.logOperation("sendPhoto", photo.chatId, startedAt, result !== null, result?.messageId, caption, "caption");
			return result;
		} catch (err) {
			logger.error("sendPhoto failed", errInfo(err));
			this.logOperation("sendPhoto", photo.chatId, startedAt, false, undefined, caption, "caption");
			return null;
		}
	}

	/**
	 * Álbum de fotos (sendMediaGroup), un solo mensaje. Telegram exige entre 2 y
	 * 10 items; el pie va SOLO en la primera porque, si varias fotos lo llevan,
	 * los clientes no muestran ninguno. Devuelve el primer mensaje del grupo.
	 */
	async sendMediaGroup(group: OutgoingMediaGroup): Promise<SendResult | null> {
		const startedAt = performance.now();
		if (group.filePaths.length < 2 || group.filePaths.length > 10) {
			logger.warn("sendMediaGroup número de fotos inválido", {
				files: group.filePaths.length,
			});
			this.logOperation(
				"sendMediaGroup",
				group.chatId,
				startedAt,
				false,
				undefined,
				group.caption,
				"caption",
			);
			return null;
		}
		try {
			const { readFile } = await import("node:fs/promises");
			const files = await Promise.all(group.filePaths.map((filePath) => readFile(filePath)));
			const boundary = `----boundary${Date.now()}`;
			const media = group.filePaths.map((filePath, index) => ({
				type: "photo",
				media: `attach://photo${index}`,
				...(index === 0 && group.caption ? { caption: group.caption } : {}),
			}));
			const parts: Buffer[] = [];
			const field = (name: string, value: string) =>
				Buffer.from(
					`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
					"utf-8",
				);
			parts.push(field("chat_id", group.chatId));
			parts.push(field("media", JSON.stringify(media)));
			group.filePaths.forEach((filePath, index) => {
				const jpeg = /\.jpe?g$/i.test(filePath);
				const ext = jpeg ? "jpg" : "png";
				const mime = jpeg ? "image/jpeg" : "image/png";
				parts.push(
					Buffer.from(
						`--${boundary}\r\nContent-Disposition: form-data; name="photo${index}"; filename="photo${index}.${ext}"\r\nContent-Type: ${mime}\r\n\r\n`,
						"utf-8",
					),
				);
				parts.push(files[index]!);
				parts.push(Buffer.from("\r\n", "utf-8"));
			});
			parts.push(Buffer.from(`--${boundary}--\r\n`, "utf-8"));
			const payload = Buffer.concat(parts);

			const res = await this.tgFetch("sendMediaGroup", {
				method: "POST",
				headers: {
					"Content-Type": `multipart/form-data; boundary=${boundary}`,
					"Content-Length": String(payload.length),
				},
				body: payload,
			});
			if (!res.ok) {
				this.logOperation(
					"sendMediaGroup",
					group.chatId,
					startedAt,
					false,
					undefined,
					group.caption,
					"caption",
				);
				return null;
			}
			const raw = (await res.json()) as {
				ok?: boolean;
				result?: Array<{ message_id?: number; chat?: { id?: number } }>;
			};
			const first = raw?.ok ? raw.result?.[0] : undefined;
			const result: SendResult | null =
				first?.message_id !== undefined
					? { chatId: first.chat?.id ?? Number(group.chatId), messageId: first.message_id }
					: null;
			this.logOperation(
				"sendMediaGroup",
				group.chatId,
				startedAt,
				result !== null,
				result?.messageId,
				group.caption,
				"caption",
			);
			return result;
		} catch (err) {
			logger.error("sendMediaGroup failed", errInfo(err));
			this.logOperation(
				"sendMediaGroup",
				group.chatId,
				startedAt,
				false,
				undefined,
				group.caption,
				"caption",
			);
			return null;
		}
	}

	async sendVideo(video: OutgoingVideo): Promise<SendResult | null> {
		const startedAt = performance.now();
		try {
			const { readFile } = await import("node:fs/promises");
			const data = await readFile(video.filePath);
			const boundary = `----boundary${Date.now()}`;
			let body = "";
			body +=
				`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${video.chatId}\r\n`;
			if (video.caption) {
				body +=
					`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${video.caption}\r\n`;
			}
			if (video.replyMarkup) {
				body +=
					`--${boundary}\r\nContent-Disposition: form-data; name="reply_markup"\r\n\r\n${JSON.stringify(video.replyMarkup)}\r\n`;
			}
			body +=
				`--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="video.mp4"\r\nContent-Type: video/mp4\r\n\r\n`;
			const buf = Buffer.from(body, "utf-8");
			const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
			const payload = Buffer.concat([buf, data, footer]);

			const res = await this.tgFetch("sendVideo", {
				method: "POST",
				headers: {
					"Content-Type": `multipart/form-data; boundary=${boundary}`,
					"Content-Length": String(payload.length),
				},
				body: payload,
			});
			if (!res.ok) {
				this.logOperation("sendVideo", video.chatId, startedAt, false, undefined, video.caption, "caption");
				return null;
			}
			const raw = await res.json();
			const result = this.parseResult(raw);
			this.logOperation("sendVideo", video.chatId, startedAt, result !== null, result?.messageId, video.caption, "caption");
			return result;
		} catch (err) {
			logger.error("sendVideo failed", errInfo(err));
			this.logOperation("sendVideo", video.chatId, startedAt, false, undefined, video.caption, "caption");
			return null;
		}
	}

	async editReplyMarkup(
		chatId: string,
		messageId: number,
		replyMarkup: Record<string, unknown>,
	): Promise<TelegramOperationResult> {
		const startedAt = performance.now();
		try {
			const res = await this.tgFetch("editMessageReplyMarkup", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					chat_id: chatId,
					message_id: messageId,
					reply_markup: replyMarkup,
				}),
			});
			this.logOperation("editMessageReplyMarkup", chatId, startedAt, res.ok);
			if (!res.ok) return { ok: false, error: await telegramError(res) };
			return { ok: true };
		} catch (err) {
			logger.warn("editReplyMarkup failed", errInfo(err));
			this.logOperation("editMessageReplyMarkup", chatId, startedAt, false);
			return { ok: false, error: String(err) };
		}
	}

	private botId: number | null = null;

	async getMe(): Promise<number | null> {
		if (this.botId) return this.botId;
		try {
			const res = await this.tgFetch("getMe", { method: "GET" });
			const raw = await res.json();
			this.botId = (raw as any)?.result?.id ?? null;
			return this.botId;
		} catch {
			return null;
		}
	}

	async deleteMessage(
		chatId: string,
		messageId: number,
	): Promise<TelegramOperationResult> {
		const startedAt = performance.now();
		try {
			const res = await this.tgFetch("deleteMessage", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					chat_id: chatId,
					message_id: messageId,
				}),
			});
			this.logOperation("deleteMessage", chatId, startedAt, res.ok);
			if (!res.ok) return { ok: false, error: await telegramError(res) };
			return { ok: true };
		} catch (err) {
			logger.warn("deleteMessage failed", errInfo(err));
			this.logOperation("deleteMessage", chatId, startedAt, false);
			return { ok: false, error: String(err) };
		}
	}

	async answerCallbackQuery(
		callbackId: string,
		text?: string,
	): Promise<void> {
		const startedAt = performance.now();
		try {
			const res = await this.tgFetch("answerCallbackQuery", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					callback_query_id: callbackId,
					text: text ?? "",
				}),
			});
			this.logOperation("answerCallbackQuery", undefined, startedAt, res.ok);
		} catch (err) {
			logger.warn("answerCallbackQuery failed (ignored)", errInfo(err));
			this.logOperation("answerCallbackQuery", undefined, startedAt, false);
		}
	}

	async sendChatAction(chatId: string, action: string): Promise<void> {
		const startedAt = performance.now();
		try {
			const res = await this.tgFetch("sendChatAction", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chat_id: chatId, action }),
			});
			this.logOperation("sendChatAction", chatId, startedAt, res.ok);
		} catch (err) {
			logger.warn("sendChatAction failed (ignored)", errInfo(err));
			this.logOperation("sendChatAction", chatId, startedAt, false);
		}
	}

	private parseResult(raw: unknown): SendResult | null {
		const data = raw as {
			ok?: boolean;
			result?: { message_id: number; chat: { id: number } };
		};
		if (data?.ok && data?.result) {
			return { chatId: data.result.chat.id, messageId: data.result.message_id };
		}
		return null;
	}
}
