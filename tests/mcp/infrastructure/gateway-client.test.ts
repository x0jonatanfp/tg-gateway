import { describe, expect, it } from "vitest";
import {
	GatewayUnavailableError,
	GatewayUnexpectedResponseError,
	TelegramRejectedError,
} from "../../../src/mcp/domain/gateway-errors.ts";
import { TgGatewayClient } from "../../../src/mcp/infrastructure/tg-gateway-client.ts";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("cliente de tg-gateway", () => {
	it("envía texto con snake_case, parse_mode y comprueba messageId", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const client = new TgGatewayClient("http://127.0.0.1:4000/", {
			fetchImpl: async (url, init) => {
				calls.push({ url, init });
				return json({ ok: true, result: { chatId: 1, messageId: 42 } });
			},
		});

		const result = await client.sendText({
			chatId: "1",
			text: "Hola",
			parseMode: "HTML",
		});

		expect(result).toEqual({ messageId: 42 });
		expect(calls[0]!.url).toBe("http://127.0.0.1:4000/api/send");
		expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
			chat_id: "1",
			text: "Hola",
			parse_mode: "HTML",
		});
	});

	it("manda foto, vídeo y álbum a sus endpoints", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const client = new TgGatewayClient("http://127.0.0.1:4000", {
			fetchImpl: async (url, init) => {
				calls.push({ url, init });
				return json({ ok: true, result: { chatId: 1, messageId: 7 } });
			},
		});

		await client.sendPhoto({
			chatId: "1",
			filePath: "/tmp/a.jpg",
			caption: "pie",
		});
		await client.sendVideo({ chatId: "1", filePath: "/tmp/a.mp4" });
		await client.sendAlbum({
			chatId: "1",
			filePaths: ["/tmp/a.jpg", "/tmp/b.png"],
		});

		expect(calls.map((call) => call.url)).toEqual([
			"http://127.0.0.1:4000/api/send-photo",
			"http://127.0.0.1:4000/api/send-video",
			"http://127.0.0.1:4000/api/send-media-group",
		]);
		expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
			chat_id: "1",
			file_path: "/tmp/a.jpg",
			caption: "pie",
		});
		expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({
			chat_id: "1",
			file_path: "/tmp/a.mp4",
		});
		expect(JSON.parse(String(calls[2]!.init!.body))).toEqual({
			chat_id: "1",
			file_paths: ["/tmp/a.jpg", "/tmp/b.png"],
		});
	});

	it("edita botones y borra mensajes aceptando ok:true sin result", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const client = new TgGatewayClient("http://127.0.0.1:4000", {
			fetchImpl: async (url, init) => {
				calls.push({ url, init });
				return json({ ok: true });
			},
		});

		await client.editButtons({
			chatId: "1",
			messageId: 9,
			replyMarkup: {},
		});
		await client.deleteMessage({ chatId: "1", messageId: 9 });

		expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
			chat_id: "1",
			message_id: 9,
			reply_markup: {},
		});
		expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({
			chat_id: "1",
			message_id: 9,
		});
	});

	it("traduce 502 a rechazo de Telegram", async () => {
		const client = new TgGatewayClient("http://127.0.0.1:4000", {
			fetchImpl: async () => json({ ok: false }, 502),
		});
		await expect(
			client.sendText({ chatId: "1", text: "x", parseMode: "HTML" }),
		).rejects.toBeInstanceOf(TelegramRejectedError);
	});

	it("traduce 500 y la red caída a gateway no disponible", async () => {
		const serverError = new TgGatewayClient("http://127.0.0.1:4000", {
			fetchImpl: async () => json({ ok: false, error: "interno" }, 500),
		});
		await expect(
			serverError.sendPhoto({ chatId: "1", filePath: "/tmp/a.jpg" }),
		).rejects.toBeInstanceOf(GatewayUnavailableError);

		const down = new TgGatewayClient("http://127.0.0.1:4000", {
			fetchImpl: async () => {
				throw new TypeError("fetch failed");
			},
		});
		await expect(down.health()).rejects.toBeInstanceOf(GatewayUnavailableError);
	});

	it("rechaza respuestas sin ok o sin messageId válido", async () => {
		const client = new TgGatewayClient("http://127.0.0.1:4000", {
			fetchImpl: async () => json({ ok: true, result: {} }),
		});
		await expect(
			client.sendText({ chatId: "1", text: "x", parseMode: "HTML" }),
		).rejects.toBeInstanceOf(GatewayUnexpectedResponseError);

		const noOk = new TgGatewayClient("http://127.0.0.1:4000", {
			fetchImpl: async () => json({ ok: false }),
		});
		await expect(
			noOk.deleteMessage({ chatId: "1", messageId: 3 }),
		).rejects.toBeInstanceOf(GatewayUnexpectedResponseError);
	});

	it("lee /health con uptime y breaker", async () => {
		const client = new TgGatewayClient("http://127.0.0.1:4000", {
			fetchImpl: async () =>
				json({
					ok: true,
					alive: true,
					uptime: 12.6,
					breaker: { state: "closed", failures: 0 },
				}),
		});
		await expect(client.health()).resolves.toEqual({
			ok: true,
			alive: true,
			uptimeSeconds: 12.6,
			breaker: { state: "closed", failures: 0 },
		});
	});
});
