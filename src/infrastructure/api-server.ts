import express from "express";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { SendMessageUseCase } from "../application/send-message.ts";
import type { SendPhotoUseCase } from "../application/send-photo.ts";
import type { SendVideoUseCase } from "../application/send-video.ts";
import type { SendMediaGroupUseCase } from "../application/send-media-group.ts";
import type { EditReplyMarkupUseCase } from "../application/edit-reply-markup.ts";
import type { RegisterHandlerUseCase } from "../application/register-handler.ts";
import type { TelegramOperationResult } from "../domain/entities/message.ts";
import type { TelegramPort } from "../domain/ports/telegram.ts";
import { QueueService } from "../domain/services/queue.ts";
import { logger } from "./logger.ts";
import { redactWebhookCredentials } from "./redact.ts";
import { runWithRequestId } from "./request-context.ts";

export class ApiServer {
	private app = express();

	constructor(
		private port: number,
		private sendMessage: SendMessageUseCase,
		private sendPhoto: SendPhotoUseCase,
		private sendVideo: SendVideoUseCase,
		private sendMediaGroup: SendMediaGroupUseCase,
		private editReplyMarkup: EditReplyMarkupUseCase,
		private registerHandler: RegisterHandlerUseCase,
		private telegram: TelegramPort,
		/**
		 * Control del circuit breaker: `info` lo publica /health y `probe`
		 * fuerza una sonda (getMe) sin esperar al cooldown.
		 */
		private circuit?: {
			info: () => Record<string, unknown>;
			probe: () => Promise<Record<string, unknown>>;
		},
	) {
		this.app.use((req, res, next) => {
			const requestId = (req.header("x-request-id") || "").trim() || randomUUID();
			res.setHeader("X-Request-Id", requestId);
			const start = performance.now();
			res.on("finish", () => {
				logger.info("api request", {
					method: req.method,
					path: req.path,
					status: res.statusCode,
					ms: Math.round(performance.now() - start),
					requestId,
				});
			});
			runWithRequestId(requestId, next);
		});

		this.app.use(express.json({ limit: "50mb" }));
		this.app.use(express.urlencoded({ extended: true, limit: "50mb" }));

		// Un envío fallido (result null) NO es éxito: el llamador debe poder
		// distinguir "enviado" de "Telegram lo rechazó".
		this.respondSend = (res, result) => {
			if (result == null) {
				res.status(502).json({
					ok: false,
					error: "Telegram rechazó el envío (result null); ver logs del gateway",
				});
				return;
			}
			res.json({ ok: true, result });
		};

		// ── Health ──
		this.app.get("/health", (_req, res) => {
			// `ok` es el VEREDICTO: Telegram responde. Antes iba fijo en `true`, y
			// eso solo decía "el proceso contesta": con el breaker abierto el
			// endpoint seguía diciendo ok y quien lo leyera de buena fe se creía
			// una salud que no estaba midiendo. Lo que dice "el proceso está
			// vivo" es `alive`.
			const breaker = this.circuit?.info();
			const state = breaker?.state as string | undefined;
			const failures = (breaker?.failures as number | undefined) ?? 0;
			// Mismo criterio que el vigilante de otro servicio: cerrado y sin fallos
			// recientes. El código de estado sigue siendo 200 para no romper a
			// quien use `curl --fail` o `res.ok`: la verdad va en el cuerpo.
			const ok = state ? state === "closed" && failures === 0 : true;
			res.json({
				ok,
				alive: true,
				uptime: process.uptime(),
				...(breaker ? { breaker } : {}),
			});
		});

		// Sonda del breaker a demanda: cierra el circuito si Telegram responde
		// sin tener que reiniciar el servicio. Solo escucha en localhost.
		this.app.post("/api/circuit/probe", async (_req, res) => {
			if (!this.circuit) {
				res.status(501).json({ ok: false, error: "circuit no disponible" });
				return;
			}
			const probe = await this.circuit.probe();
			res.json({ ok: true, probe, breaker: this.circuit.info() });
		});

		// ── Enviar mensaje ──
		this.app.post("/api/send", async (req, res) => {
			try {
				const result = await this.sendMessage.execute({
					chatId: String(req.body.chat_id ?? req.body.chatId),
					text: req.body.text,
					parseMode: req.body.parse_mode ?? req.body.parseMode,
					replyMarkup: req.body.reply_markup ?? req.body.replyMarkup,
				});
				this.respondSend(res, result);
			} catch (err) {
				res.status(500).json({ ok: false, error: String(err) });
			}
		});

		// ── Enviar foto (archivo local) ──
		this.app.post("/api/send-photo", async (req, res) => {
			try {
				const result = await this.sendPhoto.execute({
					chatId: String(req.body.chat_id ?? req.body.chatId),
					filePath: req.body.file_path ?? req.body.filePath,
					caption: req.body.caption,
					replyMarkup: req.body.reply_markup ?? req.body.replyMarkup,
				});
				this.respondSend(res, result);
			} catch (err) {
				res.status(500).json({ ok: false, error: String(err) });
			}
		});

		// ── Enviar video ──
		this.app.post("/api/send-video", async (req, res) => {
			try {
				const result = await this.sendVideo.execute({
					chatId: String(req.body.chat_id ?? req.body.chatId),
					filePath: req.body.file_path ?? req.body.filePath,
					caption: req.body.caption,
					replyMarkup: req.body.reply_markup ?? req.body.replyMarkup,
				});
				this.respondSend(res, result);
			} catch (err) {
				res.status(500).json({ ok: false, error: String(err) });
			}
		});

		// ── Enviar álbum (media group) ──
		this.app.post("/api/send-media-group", async (req, res) => {
			try {
				const filePaths = req.body.file_paths ?? req.body.filePaths ?? [];
				const result = await this.sendMediaGroup.execute({
					chatId: String(req.body.chat_id ?? req.body.chatId),
					filePaths: Array.isArray(filePaths) ? filePaths.map(String) : [],
					caption: req.body.caption,
				});
				this.respondSend(res, result);
			} catch (err) {
				res.status(500).json({ ok: false, error: String(err) });
			}
		});

		// ── Editar botones de un mensaje ──
		this.app.post("/api/edit-reply-markup", async (req, res) => {
			try {
				const result = await this.editReplyMarkup.execute(
					String(req.body.chat_id ?? req.body.chatId),
					Number(req.body.message_id ?? req.body.messageId),
					req.body.reply_markup ?? req.body.replyMarkup ?? {},
				);
				this.respondOperation(res, result);
			} catch (err) {
				res.status(500).json({ ok: false, error: String(err) });
			}
		});

		// ── Eliminar mensaje ──
		this.app.post("/api/delete-message", async (req, res) => {
			try {
				const result = await this.telegram.deleteMessage(
					String(req.body.chat_id ?? req.body.chatId),
					Number(req.body.message_id ?? req.body.messageId),
				);
				this.respondOperation(res, result);
			} catch (err) {
				res.status(500).json({ ok: false, error: String(err) });
			}
		});

		// ── Responder callback query ──
		this.app.post("/api/answer-callback", async (req, res) => {
			try {
				const cbId = req.body.callback_query_id ??
					req.body.callbackId ??
					req.body.callback_id;
				await this.telegram.answerCallbackQuery(cbId, req.body.text);
				res.json({ ok: true });
			} catch (err) {
				res.status(500).json({ ok: false, error: String(err) });
			}
		});

		// ── Indicador de escritura ──
		this.app.post("/api/send-action", async (req, res) => {
			try {
				const chatId = String(req.body.chat_id ?? req.body.chatId);
				const action = String(req.body.action ?? "typing");
				await this.telegram.sendChatAction(chatId, action);
				res.json({ ok: true });
			} catch (err) {
				res.status(500).json({ ok: false, error: String(err) });
			}
		});

		// ── Registrar handler para comandos ──
		this.app.post("/api/register-handler", (req, res) => {
			const { command, webhook } = req.body;
			if (!command || !webhook) {
				res.status(400).json({ ok: false, error: "command and webhook are required" });
				return;
			}
			this.registerHandler.execute(command, webhook);
			logger.info("handler registered", {
				command,
				webhook: redactWebhookCredentials(webhook),
			});
			res.json({ ok: true });
		});

		this.app.get("/api/handlers", (_req, res) => {
			res.json({
				ok: true,
				handlers: this.registerHandler.list().map((entry) => ({
					...entry,
					webhook: redactWebhookCredentials(entry.webhook),
				})),
			});
		});
	}

	/** Devuelve el servidor para poder comprobar en tests dónde quedó bindeado. */
	start(): Server {
		// Solo loopback: la API no tiene autenticación de ningún tipo y sus
		// clientes son procesos locales (webhooks y scripts) que llaman por
		// localhost. Sin host explícito, `listen` bindea 0.0.0.0 y cualquiera en
		// la LAN puede registrar handlers, enviar mensajes por el bot o leer las
		// credenciales embebidas en un webhook.
		return this.app.listen(this.port, "127.0.0.1", () => {
			logger.info("API server started", {
				port: this.port,
				host: "127.0.0.1",
			});
		});
	}

	/**
	 * Igual que un envío: `ok` solo si Telegram aceptó la orden. Estas dos rutas
	 * devolvían `{ok:true}` pasara lo que pasara porque el cliente se tragaba
	 * el error; ahora el 502 lleva la descripción real de Telegram.
	 */
	private respondOperation(
		res: express.Response,
		result: TelegramOperationResult,
	): void {
		if (!result.ok) {
			res.status(502).json({ ok: false, error: result.error });
			return;
		}
		res.json({ ok: true });
	}

	private respondSend: (
		res: express.Response,
		result: unknown,
	) => void;
}
