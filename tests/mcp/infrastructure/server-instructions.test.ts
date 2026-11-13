import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { TelegramUseCaseDeps } from "../../../src/mcp/application/telegram-use-cases.ts";
import { TELEGRAM_SERVER_INSTRUCTIONS } from "../../../src/mcp/domain/server-instructions.ts";
import type { TgGatewayPort } from "../../../src/mcp/domain/tg-gateway-port.ts";
import {
	createTelegramMcpServer,
	listTelegramTools,
} from "../../../src/mcp/infrastructure/mcp-server.ts";

const deps: TelegramUseCaseDeps = {
	gateway: {
		health: async () => ({ ok: true, alive: true, uptimeSeconds: 1 }),
		sendText: async () => ({ messageId: 1 }),
		sendPhoto: async () => ({ messageId: 1 }),
		sendVideo: async () => ({ messageId: 1 }),
		sendAlbum: async () => ({ messageId: 1 }),
		editButtons: async () => undefined,
		deleteMessage: async () => undefined,
	} as unknown as TgGatewayPort,
	chat: { resolve: () => "chat-resuelto" },
	files: { exists: () => true },
};

async function connectedClient(): Promise<Client> {
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	const server = createTelegramMcpServer(deps);
	const client = new Client({ name: "test", version: "0.0.0" });
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	]);
	return client;
}

describe("instrucciones del servidor (estándar MCP)", () => {
	it("el cliente las recibe en initialize con getInstructions()", async () => {
		const client = await connectedClient();
		expect(client.getInstructions()).toBe(TELEGRAM_SERVER_INSTRUCTIONS);
		await client.close();
	});

	it("no pasan de 8 KB: van en el prompt de cada turno", () => {
		expect(
			Buffer.byteLength(TELEGRAM_SERVER_INSTRUCTIONS, "utf8"),
		).toBeLessThan(8 * 1024);
	});

	it("solo nombran acciones que existen y no omiten ninguna", () => {
		const tool = listTelegramTools()[0] as unknown as {
			inputSchema: { properties: { action: { enum: string[] } } };
		};
		const actions = tool.inputSchema.properties.action.enum;
		const named =
			TELEGRAM_SERVER_INSTRUCTIONS.match(
				/\b(?:status|send_text|send_photo|send_video|send_album|edit_buttons|delete_message)\b/g,
			) ?? [];

		expect(new Set(named).size).toBe(actions.length);
		for (const name of new Set(named)) {
			expect(actions, `${name} no es una acción de la tool`).toContain(name);
		}
		for (const action of actions) {
			expect(
				TELEGRAM_SERVER_INSTRUCTIONS,
				`falta mencionar ${action}`,
			).toContain(action);
		}
	});

	it("conserva las reglas clave de uso", () => {
		for (const fragment of [
			"expresamente",
			"no preguntes por el chat_id",
			"send_album",
			"4096",
			"1024",
			"de 2 a 10 fotos",
			"502",
			"gateway caído",
			"si la rechaza, el gateway responde 502",
			"TG_GATEWAY_URL",
			"sin orden expresa",
		]) {
			expect(TELEGRAM_SERVER_INSTRUCTIONS).toContain(fragment);
		}
	});

	it("no contiene secretos ni un chat_id concreto", () => {
		// Token de bot de Telegram y valores de .env con forma de secreto.
		expect(TELEGRAM_SERVER_INSTRUCTIONS).not.toMatch(
			/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/,
		);
		expect(TELEGRAM_SERVER_INSTRUCTIONS).not.toMatch(/TG_[A-Z_]+=\S+/);
		expect(TELEGRAM_SERVER_INSTRUCTIONS).not.toMatch(/chat_id\s*[:=]\s*-?\d+/);
		// Ningún número con pinta de id (los límites y el puerto tienen 4 cifras).
		expect(TELEGRAM_SERVER_INSTRUCTIONS).not.toMatch(/\b-?\d{6,}\b/);
	});
});
