import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import type { SendMessageUseCase } from "../../src/application/send-message.ts";
import type { SendPhotoUseCase } from "../../src/application/send-photo.ts";
import type { SendVideoUseCase } from "../../src/application/send-video.ts";
import type { SendMediaGroupUseCase } from "../../src/application/send-media-group.ts";
import type { EditReplyMarkupUseCase } from "../../src/application/edit-reply-markup.ts";
import type { RegisterHandlerUseCase } from "../../src/application/register-handler.ts";
import type { TelegramPort } from "../../src/domain/ports/telegram.ts";
import { ApiServer } from "../../src/infrastructure/api-server.ts";
import { logger } from "../../src/infrastructure/logger.ts";

function createApp(circuit?: {
	info: () => Record<string, unknown>;
	probe: () => Promise<Record<string, unknown>>;
}) {
	const sendMessage = {
		execute: vi.fn().mockResolvedValue({ chatId: 1, messageId: 42 }),
	} as unknown as SendMessageUseCase;

	const sendPhoto = {
		execute: vi.fn().mockResolvedValue({ chatId: 1, messageId: 43 }),
	} as unknown as SendPhotoUseCase;

	const sendVideo = {
		execute: vi.fn().mockResolvedValue({ chatId: 1, messageId: 44 }),
	} as unknown as SendVideoUseCase;

	const sendMediaGroup = {
		execute: vi.fn().mockResolvedValue({ chatId: 1, messageId: 45 }),
	} as unknown as SendMediaGroupUseCase;

	const editReplyMarkup = {
		execute: vi.fn().mockResolvedValue({ ok: true }),
	} as unknown as EditReplyMarkupUseCase;

	const registerHandler = {
		execute: vi.fn(),
		list: vi.fn().mockReturnValue([
			{ command: "/test", webhook: "https://hook.com" },
		]),
	} as unknown as RegisterHandlerUseCase;

	const telegram = {
		deleteMessage: vi.fn().mockResolvedValue({ ok: true }),
		answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
		sendChatAction: vi.fn().mockResolvedValue(undefined),
	} as unknown as TelegramPort;

	// Build the express app internally without calling listen
	const server = new ApiServer(
		0,
		sendMessage,
		sendPhoto,
		sendVideo,
		sendMediaGroup,
		editReplyMarkup,
		registerHandler,
		telegram,
		circuit,
	);

	// Access the internal express app for supertest
	const app = (server as unknown as { app: express.Application }).app;

	return {
		app,
		server,
		sendMessage,
		sendPhoto,
		sendVideo,
		sendMediaGroup,
		editReplyMarkup,
		registerHandler,
		telegram,
	};
}

describe("ApiServer", () => {
	describe("GET /health", () => {
		it("sin circuit, ok y alive en true", async () => {
			const { app } = createApp();
			const res = await request(app).get("/health");
			expect(res.status).toBe(200);
			expect(res.body.ok).toBe(true);
			expect(res.body.alive).toBe(true);
			expect(res.body).toHaveProperty("uptime");
		});

		// `ok` significa "Telegram responde", no "el proceso contesta": con el
		// breaker abierto el endpoint decía ok:true igual y no había forma de
		// distinguirlo desde fuera.
		it("con el breaker cerrado y sin fallos, ok en true", async () => {
			const { app } = createApp({
				info: () => ({ state: "closed", failures: 0 }),
				probe: async () => ({}),
			});
			const res = await request(app).get("/health");
			expect(res.status).toBe(200);
			expect(res.body.ok).toBe(true);
			expect(res.body.alive).toBe(true);
			expect(res.body.breaker).toEqual({ state: "closed", failures: 0 });
		});

		it("con el breaker abierto, ok en false pero el proceso sigue alive", async () => {
			const { app } = createApp({
				info: () => ({ state: "open", failures: 3 }),
				probe: async () => ({}),
			});
			const res = await request(app).get("/health");
			expect(res.status).toBe(200);
			expect(res.body.ok).toBe(false);
			expect(res.body.alive).toBe(true);
		});

		it("cerrado pero con fallos recientes, ok en false", async () => {
			const { app } = createApp({
				info: () => ({ state: "closed", failures: 2 }),
				probe: async () => ({}),
			});
			const res = await request(app).get("/health");
			expect(res.body.ok).toBe(false);
		});
	});

	describe("POST /api/send", () => {
		it("sends a message and returns result", async () => {
			const { app, sendMessage } = createApp();
			const res = await request(app)
				.post("/api/send")
				.send({ chat_id: "123", text: "hello" });

			expect(res.status).toBe(200);
			expect(res.body.ok).toBe(true);
			expect(res.body.result).toEqual({ chatId: 1, messageId: 42 });
			expect(sendMessage.execute).toHaveBeenCalledWith({
				chatId: "123",
				text: "hello",
				parseMode: undefined,
				replyMarkup: undefined,
			});
		});

		it("accepts camelCase fields", async () => {
			const { app } = createApp();
			const res = await request(app)
				.post("/api/send")
				.send({ chatId: "123", text: "hello" });

			expect(res.status).toBe(200);
		});

		it("returns 500 on use case error", async () => {
			const { app, sendMessage } = createApp();
			vi.mocked(sendMessage.execute).mockRejectedValue(new Error("fail"));

			const res = await request(app)
				.post("/api/send")
				.send({ chat_id: "123", text: "hello" });

			expect(res.status).toBe(500);
			expect(res.body.ok).toBe(false);
		});

		it("returns 502 when Telegram rejects the send (result null)", async () => {
			const { app, sendMessage } = createApp();
			vi.mocked(sendMessage.execute).mockResolvedValue(null as never);

			const res = await request(app)
				.post("/api/send")
				.send({ chat_id: "123", text: "hello" });

			expect(res.status).toBe(502);
			expect(res.body.ok).toBe(false);
			expect(res.body.error).toContain("Telegram rechazó");
		});
	});

		describe("access log y request id", () => {
			it("registra método, ruta, estado y duración sin incluir el body", async () => {
				const { app } = createApp();
				const infoSpy = vi.spyOn(logger, "info");
				const body = { chat_id: "123", text: "secreto del body" };

				const res = await request(app)
					.post("/api/send")
					.send(body);

				const accessLog = infoSpy.mock.calls.find(([message]) => message === "api request");
				expect(accessLog).toBeDefined();
				expect(accessLog?.[1]).toEqual(expect.objectContaining({
					method: "POST",
					path: "/api/send",
					status: 200,
					ms: expect.any(Number),
				}));
				expect(JSON.stringify(accessLog)).not.toContain("secreto del body");
				expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
			});

			it("respeta y devuelve el X-Request-Id del llamador", async () => {
				const { app } = createApp();
				const infoSpy = vi.spyOn(logger, "info");
				const requestId = "operacion-123";

				const res = await request(app)
					.post("/api/send")
					.set("X-Request-Id", requestId)
					.send({ chat_id: "123", text: "hello" });

				expect(res.headers["x-request-id"]).toBe(requestId);
				expect(infoSpy.mock.calls.find(([message]) => message === "api request")?.[1])
					.toEqual(expect.objectContaining({ requestId }));
			});
		});

	describe("POST /api/send-photo", () => {
		it("sends a photo and returns result", async () => {
			const { app, sendPhoto } = createApp();
			const res = await request(app)
				.post("/api/send-photo")
				.send({ chat_id: "123", file_path: "/tmp/pic.jpg" });

			expect(res.status).toBe(200);
			expect(sendPhoto.execute).toHaveBeenCalledWith({
				chatId: "123",
				filePath: "/tmp/pic.jpg",
				caption: undefined,
				replyMarkup: undefined,
			});
		});

		it("accepts camelCase fields", async () => {
			const { app } = createApp();
			const res = await request(app)
				.post("/api/send-photo")
				.send({ chatId: "123", filePath: "/tmp/pic.jpg" });

			expect(res.status).toBe(200);
		});
	});

	describe("POST /api/send-video", () => {
		it("sends a video and returns result", async () => {
			const { app, sendVideo } = createApp();
			const res = await request(app)
				.post("/api/send-video")
				.send({ chat_id: "123", file_path: "/tmp/vid.mp4" });

			expect(res.status).toBe(200);
			expect(sendVideo.execute).toHaveBeenCalledWith({
				chatId: "123",
				filePath: "/tmp/vid.mp4",
				caption: undefined,
				replyMarkup: undefined,
			});
		});
	});

	describe("POST /api/send-media-group", () => {
		it("sends a media group with snake_case fields", async () => {
			const { app, sendMediaGroup } = createApp();
			const res = await request(app)
				.post("/api/send-media-group")
				.send({
					chat_id: "123",
					file_paths: ["/tmp/a.png", "/tmp/b.png"],
					caption: "the post",
				});

			expect(res.status).toBe(200);
			expect(sendMediaGroup.execute).toHaveBeenCalledWith({
				chatId: "123",
				filePaths: ["/tmp/a.png", "/tmp/b.png"],
				caption: "the post",
			});
		});

		it("accepts camelCase fields and defaults file_paths to []", async () => {
			const { app, sendMediaGroup } = createApp();
			const res = await request(app)
				.post("/api/send-media-group")
				.send({ chatId: "123", filePaths: ["/tmp/a.png", "/tmp/b.png"] });

			expect(res.status).toBe(200);
			expect(sendMediaGroup.execute).toHaveBeenCalledWith({
				chatId: "123",
				filePaths: ["/tmp/a.png", "/tmp/b.png"],
				caption: undefined,
			});
		});
	});

	describe("POST /api/edit-reply-markup", () => {
		it("edits reply markup", async () => {
			const { app, editReplyMarkup } = createApp();
			const res = await request(app)
				.post("/api/edit-reply-markup")
				.send({
					chat_id: "123",
					message_id: 5,
					reply_markup: { inline_keyboard: [] },
				});

			expect(res.status).toBe(200);
			expect(editReplyMarkup.execute).toHaveBeenCalledWith(
				"123",
				5,
				{ inline_keyboard: [] },
			);
		});

		it("returns 502 with Telegram's real error when the order is rejected", async () => {
			const { app, editReplyMarkup } = createApp();
			vi.mocked(editReplyMarkup.execute).mockResolvedValue({
				ok: false,
				error: "Bad Request: message to edit not found",
			});

			const res = await request(app)
				.post("/api/edit-reply-markup")
				.send({ chat_id: "123", message_id: 5, reply_markup: {} });

			expect(res.status).toBe(502);
			expect(res.body).toEqual({
				ok: false,
				error: "Bad Request: message to edit not found",
			});
		});
	});

	describe("POST /api/delete-message", () => {
		it("deletes a message", async () => {
			const { app, telegram } = createApp();
			const res = await request(app)
				.post("/api/delete-message")
				.send({ chat_id: "123", message_id: 5 });

			expect(res.status).toBe(200);
			expect(res.body).toEqual({ ok: true });
			expect(telegram.deleteMessage).toHaveBeenCalledWith("123", 5);
		});

		it("returns 502 with Telegram's real error when it cannot delete", async () => {
			const { app, telegram } = createApp();
			vi.mocked(telegram.deleteMessage).mockResolvedValue({
				ok: false,
				error: "Bad Request: message to delete not found",
			});

			const res = await request(app)
				.post("/api/delete-message")
				.send({ chat_id: "123", message_id: 5 });

			expect(res.status).toBe(502);
			expect(res.body).toEqual({
				ok: false,
				error: "Bad Request: message to delete not found",
			});
		});
	});

	describe("POST /api/answer-callback", () => {
		it("answers a callback query", async () => {
			const { app, telegram } = createApp();
			const res = await request(app)
				.post("/api/answer-callback")
				.send({ callback_query_id: "cb-1", text: "done" });

			expect(res.status).toBe(200);
			expect(telegram.answerCallbackQuery).toHaveBeenCalledWith(
				"cb-1",
				"done",
			);
		});

		it("accepts camelCase callbackId", async () => {
			const { app, telegram } = createApp();
			const res = await request(app)
				.post("/api/answer-callback")
				.send({ callbackId: "cb-2", text: "ok" });

			expect(res.status).toBe(200);
			expect(telegram.answerCallbackQuery).toHaveBeenCalledWith(
				"cb-2",
				"ok",
			);
		});
	});

	describe("POST /api/register-handler", () => {
		it("registers a handler", async () => {
			const { app, registerHandler } = createApp();
			const res = await request(app)
				.post("/api/register-handler")
				.send({ command: "/test", webhook: "https://hook.com" });

			expect(res.status).toBe(200);
			expect(registerHandler.execute).toHaveBeenCalledWith(
				"/test",
				"https://hook.com",
			);
		});

		it("returns 400 when command is missing", async () => {
			const { app } = createApp();
			const res = await request(app)
				.post("/api/register-handler")
				.send({ webhook: "https://hook.com" });

			expect(res.status).toBe(400);
			expect(res.body.ok).toBe(false);
		});

		it("returns 400 when webhook is missing", async () => {
			const { app } = createApp();
			const res = await request(app)
				.post("/api/register-handler")
				.send({ command: "/test" });

			expect(res.status).toBe(400);
			expect(res.body.ok).toBe(false);
		});
	});

	describe("GET /api/handlers", () => {
		it("lists handlers", async () => {
			const { app } = createApp();
			const res = await request(app).get("/api/handlers");

			expect(res.status).toBe(200);
			expect(res.body.handlers).toEqual([
				{ command: "/test", webhook: "https://hook.com" },
			]);
		});

		// Un webhook puede llevar credenciales en el userinfo, y ese token autoriza
		// a inyectar updates de Telegram como si vinieran del chat configurado.
		// Servirlo en claro convertía un endpoint de diagnóstico en un filtrado de
		// credenciales.
		it("no filtra las credenciales embebidas en la URL del webhook", async () => {
			const { app, registerHandler } = createApp();
			(registerHandler.list as ReturnType<typeof vi.fn>).mockReturnValue([
				{
					command: "__default__",
					webhook: "http://service-a:pass@localhost:14001/tg-update",
				},
			]);

			const res = await request(app).get("/api/handlers");

			expect(res.status).toBe(200);
			const [entry] = res.body.handlers;
			expect(entry.webhook).not.toContain("service-a:pass");
			expect(entry.webhook).toBe("http://***:***@localhost:14001/tg-update");
		});

		it("deja intactas las URLs sin credenciales", async () => {
			const { app } = createApp();
			const res = await request(app).get("/api/handlers");

			expect(res.body.handlers[0].webhook).toBe("https://hook.com");
		});
	});

	// Sin host explícito, `listen` bindea 0.0.0.0 y la API —que no tiene
	// autenticación— queda expuesta a la LAN entera. El firewall la tapaba,
	// pero eso es una sola capa: el binding tiene que ser loopback por sí mismo.
	describe("binding", () => {
		it("escucha solo en loopback, no en todas las interfaces", async () => {
			const { server } = createApp();

			const http = server.start();
			try {
				// `listen` es asíncrono: si aún no ha emitido, se espera; si ya
				// emitió, engancharse después colgaría el test para siempre.
				if (!http.listening) {
					await new Promise<void>((resolve) => http.once("listening", resolve));
				}
				const address = http.address();
				expect(typeof address).toBe("object");
				expect((address as { address: string }).address).toBe("127.0.0.1");
			} finally {
				await new Promise<void>((resolve) => http.close(() => resolve()));
			}
		});
	});

	describe("parse_mode handling", () => {
		it("passes parse_mode to sendMessage use case", async () => {
			const { app, sendMessage } = createApp();
			await request(app)
				.post("/api/send")
				.send({ chat_id: "1", text: "hi", parse_mode: "HTML" });

			expect(sendMessage.execute).toHaveBeenCalledWith(
				expect.objectContaining({ parseMode: "HTML" }),
			);
		});

		it("passes snake_case parse_mode", async () => {
			const { app, sendMessage } = createApp();
			await request(app)
				.post("/api/send")
				.send({ chat_id: "1", text: "hi", parse_mode: "Markdown" });

			expect(sendMessage.execute).toHaveBeenCalledWith(
				expect.objectContaining({ parseMode: "Markdown" }),
			);
		});
	});

	describe("reply_markup handling", () => {
		it("passes reply_markup to sendMessage use case", async () => {
			const { app, sendMessage } = createApp();
			const markup = { inline_keyboard: [[{ text: "Go", url: "https://x.com" }]] };
			await request(app)
				.post("/api/send")
				.send({ chat_id: "1", text: "hi", reply_markup: markup });

			expect(sendMessage.execute).toHaveBeenCalledWith(
				expect.objectContaining({ replyMarkup: markup }),
			);
		});

		it("passes camelCase replyMarkup to sendMessage use case", async () => {
			const { app, sendMessage } = createApp();
			const markup = { inline_keyboard: [] };
			await request(app)
				.post("/api/send")
				.send({ chatId: "1", text: "hi", replyMarkup: markup });

			expect(sendMessage.execute).toHaveBeenCalledWith(
				expect.objectContaining({ replyMarkup: markup }),
			);
		});
	});

	describe("error propagation", () => {
		it("returns 500 when send-photo fails", async () => {
			const { app, sendPhoto } = createApp();
			vi.mocked(sendPhoto.execute).mockRejectedValue(new Error("disk full"));

			const res = await request(app)
				.post("/api/send-photo")
				.send({ chat_id: "1", file_path: "/tmp/pic.jpg" });

			expect(res.status).toBe(500);
			expect(res.body.ok).toBe(false);
		});

		it("returns 500 when send-video fails", async () => {
			const { app, sendVideo } = createApp();
			vi.mocked(sendVideo.execute).mockRejectedValue(new Error("oom"));

			const res = await request(app)
				.post("/api/send-video")
				.send({ chat_id: "1", file_path: "/tmp/vid.mp4" });

			expect(res.status).toBe(500);
		});

		it("returns 500 when edit-reply-markup fails", async () => {
			const { app, editReplyMarkup } = createApp();
			vi.mocked(editReplyMarkup.execute).mockRejectedValue(new Error("fail"));

			const res = await request(app)
				.post("/api/edit-reply-markup")
				.send({ chat_id: "1", message_id: 5, reply_markup: {} });

			expect(res.status).toBe(500);
		});
	});
});

describe("POST /api/send-action", () => {
	it("llama a sendChatAction con chat_id y action", async () => {
		const { app, telegram } = createApp();

		const res = await request(app)
			.post("/api/send-action")
			.send({ chat_id: "99", action: "typing" });

		expect(res.status).toBe(200);
		expect(res.body).toEqual({ ok: true });
		expect(vi.mocked(telegram.sendChatAction)).toHaveBeenCalledWith("99", "typing");
	});

	it("usa 'typing' como acción por defecto si no se especifica", async () => {
		const { app, telegram } = createApp();

		await request(app).post("/api/send-action").send({ chat_id: "42" });

		expect(vi.mocked(telegram.sendChatAction)).toHaveBeenCalledWith("42", "typing");
	});

	it("acepta chatId como alias de chat_id", async () => {
		const { app, telegram } = createApp();

		await request(app).post("/api/send-action").send({ chatId: "7", action: "typing" });

		expect(vi.mocked(telegram.sendChatAction)).toHaveBeenCalledWith("7", "typing");
	});
});
