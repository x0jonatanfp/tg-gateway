import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { TelegramUseCaseDeps } from "../application/telegram-use-cases.ts";
import { runTelegramAction } from "../application/telegram-use-cases.ts";
import { TELEGRAM_SERVER_INSTRUCTIONS } from "../domain/server-instructions.ts";
import {
	TELEGRAM_TOOL_ANNOTATIONS,
	TELEGRAM_TOOL_DEFINITION,
	TELEGRAM_TOOL_NAME,
} from "../domain/tool-definitions.ts";

export function listTelegramTools() {
	return [
		{
			name: TELEGRAM_TOOL_DEFINITION.name,
			description: TELEGRAM_TOOL_DEFINITION.description,
			inputSchema: TELEGRAM_TOOL_DEFINITION.parameters,
			annotations: { ...TELEGRAM_TOOL_ANNOTATIONS },
		},
	];
}

export async function callTelegramTool(
	deps: TelegramUseCaseDeps,
	args: Record<string, unknown>,
): Promise<{
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}> {
	const action = typeof args.action === "string" ? args.action.trim() : "";
	const params =
		args.params &&
		typeof args.params === "object" &&
		!Array.isArray(args.params)
			? (args.params as Record<string, unknown>)
			: {};
	if (!action) {
		return {
			content: [{ type: "text", text: "action es obligatoria" }],
			isError: true,
		};
	}
	const outcome = await runTelegramAction(deps, action, params);
	return {
		content: [{ type: "text", text: outcome.text }],
		...(outcome.success ? {} : { isError: true }),
	};
}

/** Servidor MCP stdio con la tool `telegram`. */
export function createTelegramMcpServer(deps: TelegramUseCaseDeps): Server {
	const server = new Server(
		{ name: "tg-mcp", version: "0.1.0" },
		{
			capabilities: { tools: {} },
			// Estándar MCP: el cliente las recibe en `initialize`.
			instructions: TELEGRAM_SERVER_INSTRUCTIONS,
		},
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: listTelegramTools(),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		if (req.params.name !== TELEGRAM_TOOL_NAME) {
			return {
				content: [
					{ type: "text", text: `Tool desconocida: '${req.params.name}'` },
				],
				isError: true,
			};
		}
		const args = (req.params.arguments ?? {}) as Record<string, unknown>;
		return callTelegramTool(deps, args);
	});

	return server;
}

export async function startTelegramMcpServer(
	deps: TelegramUseCaseDeps,
): Promise<void> {
	const server = createTelegramMcpServer(deps);
	const transport = new StdioServerTransport();
	await server.connect(transport);
}
