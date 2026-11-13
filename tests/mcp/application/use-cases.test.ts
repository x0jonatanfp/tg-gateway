import { afterEach, describe, expect, it, vi } from "vitest";
import { runTelegramAction } from "../../../src/mcp/application/telegram-use-cases.ts";
import { ChatResolutionError } from "../../../src/mcp/domain/chat-resolver.ts";
import {
	GatewayUnavailableError,
	TelegramRejectedError,
} from "../../../src/mcp/domain/gateway-errors.ts";
import type { TgGatewayPort } from "../../../src/mcp/domain/tg-gateway-port.ts";

// ID reconocible: si aparece en una respuesta o en un log, el test falla.
const CHAT_ID = "987654321";

function setup() {
	const gateway = {
		health: vi.fn(async () => ({
			ok: true,
			alive: true,
			uptimeSeconds: 120,
			breaker: { state: "closed", failures: 0 },
		})),
		sendText: vi.fn(async () => ({ messageId: 42 })),
		sendPhoto: vi.fn(async () => ({ messageId: 43 })),
		sendVideo: vi.fn(async () => ({ messageId: 44 })),
		sendAlbum: vi.fn(async () => ({ messageId: 45 })),
		editButtons: vi.fn(async () => undefined),
		deleteMessage: vi.fn(async () => undefined),
	};
	const chat = { resolve: vi.fn((_explicit?: string) => CHAT_ID) };
	const files = { exists: vi.fn((_filePath: string) => true) };
	const deps = {
		gateway: gateway as unknown as TgGatewayPort,
		chat,
		files,
	};
	return { deps, gateway, chat, files };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("status", () => {
	it("informa de la salud sin resolver el chat", async () => {
		const { deps, chat } = setup();
		const outcome = await runTelegramAction(deps, "status", {});
		expect(outcome.success).toBe(true);
		expect(outcome.text).toContain("tg-gateway OK");
		expect(outcome.text).toContain("uptime: 120 s");
		expect(chat.resolve).not.toHaveBeenCalled();
	});

	it("falla si el gateway vive pero Telegram no responde", async () => {
		const { deps, gateway } = setup();
		gateway.health.mockResolvedValueOnce({
			ok: false,
			alive: true,
			uptimeSeconds: 50,
			breaker: { state: "open", failures: 5 },
		});
		const outcome = await runTelegramAction(deps, "status", {});
		expect(outcome.success).toBe(false);
		expect(outcome.text).toContain("Telegram no responde");
		expect(outcome.text).toContain("open");
	});
});

describe("send_text", () => {
	it("envía texto plano escapado a HTML", async () => {
		const { deps, gateway } = setup();
		const outcome = await runTelegramAction(deps, "send_text", {
			text: "Hola <b> & tú",
		});
		expect(outcome).toEqual({
			success: true,
			text: "Mensaje enviado. message_id: 42",
		});
		expect(gateway.sendText).toHaveBeenCalledWith({
			chatId: CHAT_ID,
			text: "Hola &lt;b&gt; &amp; tú",
			parseMode: "HTML",
		});
	});

	it("respeta html y markdown sin escapar", async () => {
		const html = setup();
		await runTelegramAction(html.deps, "send_text", {
			text: "<b>Hola</b>",
			parse_mode: "html",
		});
		expect(html.gateway.sendText).toHaveBeenCalledWith({
			chatId: CHAT_ID,
			text: "<b>Hola</b>",
			parseMode: "HTML",
		});

		const md = setup();
		await runTelegramAction(md.deps, "send_text", {
			text: "*Hola*",
			parse_mode: "markdown",
		});
		expect(md.gateway.sendText).toHaveBeenCalledWith({
			chatId: CHAT_ID,
			text: "*Hola*",
			parseMode: "Markdown",
		});
	});

	it("acepta 4096 y rechaza 4097 sin enviar ni truncar", async () => {
		const first = setup();
		const ok = await runTelegramAction(first.deps, "send_text", {
			text: "a".repeat(4096),
		});
		expect(ok.success).toBe(true);

		const second = setup();
		const tooLong = await runTelegramAction(second.deps, "send_text", {
			text: "a".repeat(4097),
		});
		expect(tooLong.success).toBe(false);
		expect(tooLong.text).toContain("4096");
		expect(tooLong.text).toContain("Pártelo");
		expect(second.gateway.sendText).not.toHaveBeenCalled();
	});

	it("rechaza texto vacío y parse_mode inválido", async () => {
		const { deps, gateway } = setup();
		expect(
			(await runTelegramAction(deps, "send_text", { text: "   " })).text,
		).toContain("no puede estar vacío");
		expect(
			(
				await runTelegramAction(deps, "send_text", {
					text: "x",
					parse_mode: "rtf",
				})
			).text,
		).toContain("plain, html o markdown");
		expect(gateway.sendText).not.toHaveBeenCalled();
	});
});

describe("send_photo y send_video", () => {
	it("envía la foto con caption", async () => {
		const { deps, gateway } = setup();
		const outcome = await runTelegramAction(deps, "send_photo", {
			file_path: "/tmp/foto.jpg",
			caption: "Pie",
		});
		expect(outcome).toEqual({
			success: true,
			text: "Foto enviada. message_id: 43",
		});
		expect(gateway.sendPhoto).toHaveBeenCalledWith({
			chatId: CHAT_ID,
			filePath: "/tmp/foto.jpg",
			caption: "Pie",
		});
	});

	it("envía el vídeo mp4", async () => {
		const { deps, gateway } = setup();
		const outcome = await runTelegramAction(deps, "send_video", {
			file_path: "/tmp/clip.mp4",
		});
		expect(outcome).toEqual({
			success: true,
			text: "Vídeo enviado. message_id: 44",
		});
		expect(gateway.sendVideo).toHaveBeenCalledWith({
			chatId: CHAT_ID,
			filePath: "/tmp/clip.mp4",
		});
	});

	it("rechaza extensiones que el gateway etiqueta mal", async () => {
		const photo = setup();
		const badPhoto = await runTelegramAction(photo.deps, "send_photo", {
			file_path: "/tmp/foto.gif",
		});
		expect(badPhoto.text).toContain(".jpg, .jpeg, .png");
		expect(photo.gateway.sendPhoto).not.toHaveBeenCalled();

		const video = setup();
		const badVideo = await runTelegramAction(video.deps, "send_video", {
			file_path: "/tmp/clip.mov",
		});
		expect(badVideo.text).toContain(".mp4");
		expect(video.gateway.sendVideo).not.toHaveBeenCalled();
	});

	it("rechaza un fichero inexistente antes de llamar al gateway", async () => {
		const { deps, gateway, files } = setup();
		files.exists.mockReturnValueOnce(false);
		const outcome = await runTelegramAction(deps, "send_photo", {
			file_path: "/tmp/no-existe.jpg",
		});
		expect(outcome.success).toBe(false);
		expect(outcome.text).toContain("No existe el archivo");
		expect(gateway.sendPhoto).not.toHaveBeenCalled();
	});

	it("limita el caption a 1024 caracteres", async () => {
		const first = setup();
		expect(
			(
				await runTelegramAction(first.deps, "send_photo", {
					file_path: "/tmp/foto.jpg",
					caption: "c".repeat(1024),
				})
			).success,
		).toBe(true);

		const second = setup();
		const tooLong = await runTelegramAction(second.deps, "send_photo", {
			file_path: "/tmp/foto.jpg",
			caption: "c".repeat(1025),
		});
		expect(tooLong.success).toBe(false);
		expect(tooLong.text).toContain("1024");
		expect(second.gateway.sendPhoto).not.toHaveBeenCalled();
	});
});

describe("send_album", () => {
	it("envía 2-10 fotos en un solo mensaje", async () => {
		const { deps, gateway } = setup();
		const files = ["/tmp/a.jpg", "/tmp/b.png", "/tmp/c.jpeg"];
		const outcome = await runTelegramAction(deps, "send_album", {
			file_paths: files,
			caption: "Serie",
		});
		expect(outcome).toEqual({
			success: true,
			text: "Álbum enviado (3 fotos). message_id: 45",
		});
		expect(gateway.sendAlbum).toHaveBeenCalledWith({
			chatId: CHAT_ID,
			filePaths: files,
			caption: "Serie",
		});
	});

	it("acepta 10 fotos y rechaza 1 u 11", async () => {
		const ten = setup();
		const tenFiles = Array.from({ length: 10 }, (_, i) => `/tmp/${i}.jpg`);
		expect(
			(
				await runTelegramAction(ten.deps, "send_album", {
					file_paths: tenFiles,
				})
			).success,
		).toBe(true);

		const one = setup();
		const tooFew = await runTelegramAction(one.deps, "send_album", {
			file_paths: ["/tmp/a.jpg"],
		});
		expect(tooFew.text).toContain("entre 2 y 10");
		expect(one.gateway.sendAlbum).not.toHaveBeenCalled();

		const eleven = setup();
		const tooMany = await runTelegramAction(eleven.deps, "send_album", {
			file_paths: Array.from({ length: 11 }, (_, i) => `/tmp/${i}.jpg`),
		});
		expect(tooMany.text).toContain("entre 2 y 10");
		expect(eleven.gateway.sendAlbum).not.toHaveBeenCalled();
	});

	it("valida cada foto del álbum", async () => {
		const badExt = setup();
		expect(
			(
				await runTelegramAction(badExt.deps, "send_album", {
					file_paths: ["/tmp/a.jpg", "/tmp/b.gif"],
				})
			).text,
		).toContain(".jpg, .jpeg, .png");

		const missing = setup();
		missing.files.exists.mockReturnValueOnce(true).mockReturnValueOnce(false);
		expect(
			(
				await runTelegramAction(missing.deps, "send_album", {
					file_paths: ["/tmp/a.jpg", "/tmp/b.jpg"],
				})
			).text,
		).toContain("No existe el archivo");
		expect(missing.gateway.sendAlbum).not.toHaveBeenCalled();
	});
});

describe("edit_buttons y delete_message", () => {
	it("actualiza botones con reply_markup", async () => {
		const { deps, gateway } = setup();
		const markup = {
			inline_keyboard: [[{ text: "Sí", callback_data: "approve" }]],
		};
		const outcome = await runTelegramAction(deps, "edit_buttons", {
			message_id: 9,
			reply_markup: markup,
		});
		expect(outcome).toEqual({
			success: true,
			text: "Botones actualizados. message_id: 9",
		});
		expect(gateway.editButtons).toHaveBeenCalledWith({
			chatId: CHAT_ID,
			messageId: 9,
			replyMarkup: markup,
		});
	});

	it("sin reply_markup quita los botones", async () => {
		const { deps, gateway } = setup();
		const outcome = await runTelegramAction(deps, "edit_buttons", {
			message_id: 9,
		});
		expect(outcome.text).toContain("eliminados");
		expect(gateway.editButtons).toHaveBeenCalledWith({
			chatId: CHAT_ID,
			messageId: 9,
			replyMarkup: {},
		});
	});

	it("borra un mensaje", async () => {
		const { deps, gateway } = setup();
		const outcome = await runTelegramAction(deps, "delete_message", {
			message_id: 9,
		});
		expect(outcome).toEqual({ success: true, text: "Mensaje 9 borrado." });
		expect(gateway.deleteMessage).toHaveBeenCalledWith({
			chatId: CHAT_ID,
			messageId: 9,
		});
	});

	it("exige message_id entero positivo", async () => {
		const { deps, gateway } = setup();
		for (const messageId of [0, -3, 1.5, "9"]) {
			const outcome = await runTelegramAction(deps, "delete_message", {
				message_id: messageId,
			});
			expect(outcome.success).toBe(false);
			expect(outcome.text).toContain("entero positivo");
		}
		expect(gateway.deleteMessage).not.toHaveBeenCalled();
	});
});

describe("errores del gateway", () => {
	it("mapea 502 a rechazo de Telegram", async () => {
		const { deps, gateway } = setup();
		gateway.sendText.mockRejectedValueOnce(new TelegramRejectedError());
		const outcome = await runTelegramAction(deps, "send_text", { text: "x" });
		expect(outcome).toEqual({
			success: false,
			text: "Telegram rechazó el envío.",
		});
	});

	it("mapea 500 y red caída a gateway caído", async () => {
		const { deps, gateway } = setup();
		gateway.sendPhoto.mockRejectedValueOnce(new GatewayUnavailableError());
		expect(
			(
				await runTelegramAction(deps, "send_photo", {
					file_path: "/tmp/a.jpg",
				})
			).text,
		).toBe("tg-gateway caído o sin respuesta.");
	});

	it("si no hay chat resoluble no llama al gateway", async () => {
		const { deps, gateway, chat } = setup();
		chat.resolve.mockImplementationOnce(() => {
			throw new ChatResolutionError(
				"No se pudo resolver el chat privado por defecto.",
			);
		});
		const outcome = await runTelegramAction(deps, "send_text", { text: "x" });
		expect(outcome.success).toBe(false);
		expect(outcome.text).toContain("No se pudo resolver el chat privado");
		expect(gateway.sendText).not.toHaveBeenCalled();
	});
});

describe("contrato del despacho", () => {
	it("rechaza acción desconocida y parámetros desconocidos", async () => {
		const { deps, gateway } = setup();
		expect((await runTelegramAction(deps, "volar", {})).text).toContain(
			"Acción desconocida",
		);
		const unknown = await runTelegramAction(deps, "send_text", {
			text: "x",
			fichero: "/tmp/a.jpg",
		});
		expect(unknown.text).toContain("Parámetros desconocidos");
		expect(unknown.text).toContain("text, parse_mode, chat");
		expect(gateway.sendText).not.toHaveBeenCalled();
	});

	it("exige los parámetros obligatorios de cada acción", async () => {
		const { deps } = setup();
		expect((await runTelegramAction(deps, "send_text", {})).text).toContain(
			"text es obligatorio",
		);
		expect((await runTelegramAction(deps, "send_album", {})).text).toContain(
			"file_paths es obligatorio",
		);
		expect((await runTelegramAction(deps, "edit_buttons", {})).text).toContain(
			"message_id es obligatorio",
		);
	});

	it("usa el chat explícito cuando se pasa", async () => {
		const { deps, gateway, chat } = setup();
		await runTelegramAction(deps, "send_text", {
			text: "x",
			chat: "555",
		});
		expect(chat.resolve).toHaveBeenCalledWith("555");
		expect(gateway.sendText).toHaveBeenCalledWith({
			chatId: CHAT_ID,
			text: "x",
			parseMode: "HTML",
		});
	});

	it("no filtra el chat_id en respuestas ni en logs", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const runs: Array<Promise<{ text: string }>> = [];
		const { deps } = setup();
		runs.push(runTelegramAction(deps, "status", {}));
		runs.push(runTelegramAction(deps, "send_text", { text: "x" }));
		runs.push(
			runTelegramAction(deps, "send_photo", { file_path: "/tmp/a.jpg" }),
		);
		runs.push(
			runTelegramAction(deps, "send_video", { file_path: "/tmp/a.mp4" }),
		);
		runs.push(
			runTelegramAction(deps, "send_album", {
				file_paths: ["/tmp/a.jpg", "/tmp/b.jpg"],
			}),
		);
		runs.push(runTelegramAction(deps, "edit_buttons", { message_id: 1 }));
		runs.push(runTelegramAction(deps, "delete_message", { message_id: 1 }));
		const outcomes = await Promise.all(runs);

		for (const outcome of outcomes) expect(outcome.text).not.toContain(CHAT_ID);
		for (const spy of [log, error, warn]) {
			for (const call of spy.mock.calls) {
				expect(JSON.stringify(call)).not.toContain(CHAT_ID);
			}
		}
	});
});
