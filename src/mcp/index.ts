import { fileURLToPath } from "node:url";
import { loadTgMcpConfig } from "./infrastructure/config.ts";
import { createDefaultChatResolver } from "./infrastructure/default-chat.ts";
import { startTelegramMcpServer } from "./infrastructure/mcp-server.ts";
import { createMediaFileProbe } from "./infrastructure/media-file-probe.ts";
import { TgGatewayClient } from "./infrastructure/tg-gateway-client.ts";

// El .env que carga el servicio vive junto a la instalación y este bundle en
// <install>/dist/, así que la ruta se calcula desde el propio módulo y nunca
// desde el directorio de trabajo: el cliente MCP puede arrancarnos en cualquiera.
const DEFAULT_ENV_FILE = fileURLToPath(new URL("../.env", import.meta.url));

// Composition root: entorno → cliente del gateway, chat y sondeo de ficheros.
// El chat_id nunca se imprime; este proceso no arranca con una config rota.
async function main(): Promise<void> {
	const config = loadTgMcpConfig(process.env, DEFAULT_ENV_FILE);
	await startTelegramMcpServer({
		gateway: new TgGatewayClient(config.gatewayUrl),
		chat: createDefaultChatResolver({
			envFile: config.envFile,
			envDefaultChatId: config.defaultChatId,
		}),
		files: createMediaFileProbe(),
	});
}

main().catch((err) => {
	// stdio es el canal del protocolo: el error va a stderr, nunca a stdout.
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
