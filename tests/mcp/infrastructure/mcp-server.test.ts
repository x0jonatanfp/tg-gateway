import { describe, expect, it, vi } from "vitest";
import type { TelegramUseCaseDeps } from "../../../src/mcp/application/telegram-use-cases.ts";
import { ACTION_PARAMS, VALID_ACTIONS } from "../../../src/mcp/domain/action-params.ts";
import type { TgGatewayPort } from "../../../src/mcp/domain/tg-gateway-port.ts";
import {
	TELEGRAM_TOOL_DEFINITION,
	TELEGRAM_TOOL_NAME,
} from "../../../src/mcp/domain/tool-definitions.ts";
import {
	callTelegramTool,
	listTelegramTools,
} from "../../../src/mcp/infrastructure/mcp-server.ts";

function deps(): TelegramUseCaseDeps {
	const gateway = {
		health: vi.fn(async () => ({
			ok: true,
			alive: true,
			uptimeSeconds: 5,
		})),
		sendText: vi.fn(async () => ({ messageId: 1 })),
		sendPhoto: vi.fn(async () => ({ messageId: 1 })),
		sendVideo: vi.fn(async () => ({ messageId: 1 })),
		sendAlbum: vi.fn(async () => ({ messageId: 1 })),
		editButtons: vi.fn(async () => undefined),
		deleteMessage: vi.fn(async () => undefined),
	};
	return {
		gateway: gateway as unknown as TgGatewayPort,
		chat: { resolve: () => "987654321" },
		files: { exists: () => true },
	};
}

describe("servidor MCP", () => {
	it("expone exactamente la tool telegram", () => {
		const tools = listTelegramTools();
		expect(tools.map((tool) => tool.name)).toEqual([TELEGRAM_TOOL_NAME]);
		expect(TELEGRAM_TOOL_NAME).toBe("telegram");
	});

	it("la descripción exige que el usuario lo haya pedido expresamente", () => {
		expect(TELEGRAM_TOOL_DEFINITION.description).toContain("expresamente");
	});

	it("publica el peor caso: escribe y puede ser destructiva", () => {
		expect(listTelegramTools()[0]!.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: true,
		});
	});

	it("el enum de acciones y los parámetros coinciden con el dominio", () => {
		const properties = TELEGRAM_TOOL_DEFINITION.parameters.properties;
		expect([...properties.action.enum]).toEqual([...VALID_ACTIONS]);
		const described = new Set(
			Object.keys(properties.params.properties as Record<string, unknown>),
		);
		for (const action of VALID_ACTIONS) {
			const spec = ACTION_PARAMS[action];
			for (const param of [...spec.required, ...spec.optional]) {
				expect(described.has(param)).toBe(true);
			}
		}
	});

	it("despacha status y marca error cuando falla", async () => {
		const ok = await callTelegramTool(deps(), {
			action: "status",
			params: {},
		});
		expect(ok.isError).toBeUndefined();
		expect(ok.content[0]!.text).toContain("tg-gateway OK");

		const failed = await callTelegramTool(deps(), {
			action: "send_text",
			params: {},
		});
		expect(failed.isError).toBe(true);
	});

	it("exige action y rechaza tool desconocida por el despacho", async () => {
		const missing = await callTelegramTool(deps(), {});
		expect(missing.isError).toBe(true);
		expect(missing.content[0]!.text).toContain("action es obligatoria");

		const unknown = await callTelegramTool(deps(), {
			action: "telegram_otra",
		});
		expect(unknown.isError).toBe(true);
	});
});
