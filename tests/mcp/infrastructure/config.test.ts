import { describe, expect, it } from "vitest";
import {
	DEFAULT_GATEWAY_URL,
	loadTgMcpConfig,
} from "../../../src/mcp/infrastructure/config.ts";

// Lo que calcula src/mcp/index.ts con import.meta.url: el .env junto a la
// instalación, no uno relativo al directorio de trabajo.
const INSTALL_ENV_FILE = "/opt/tg-gateway/.env";

describe("configuración", () => {
	it("usa el env file junto a la instalación que le pasa el punto de entrada", () => {
		expect(loadTgMcpConfig({}, INSTALL_ENV_FILE)).toEqual({
			gatewayUrl: DEFAULT_GATEWAY_URL,
			envFile: INSTALL_ENV_FILE,
			defaultChatId: undefined,
		});
		expect(DEFAULT_GATEWAY_URL).toBe("http://127.0.0.1:4000");
	});

	it("no inventa un .env relativo cuando no recibe default", () => {
		// Un ".env" aquí sería el del cwd: justo el fallo que se está corrigiendo.
		expect(loadTgMcpConfig({}).envFile).toBe("");
	});

	it("TG_GATEWAY_ENV_FILE manda sobre el default", () => {
		const config = loadTgMcpConfig(
			{ TG_GATEWAY_ENV_FILE: " /etc/tg-gateway/custom.env " },
			INSTALL_ENV_FILE,
		);
		expect(config.envFile).toBe("/etc/tg-gateway/custom.env");
	});

	it("respeta el resto de overrides y trata los vacíos como ausentes", () => {
		expect(
			loadTgMcpConfig(
				{
					TG_GATEWAY_URL: " http://127.0.0.1:4100 ",
					TG_GATEWAY_ENV_FILE: "",
					TG_DEFAULT_CHAT_ID: " 42 ",
				},
				INSTALL_ENV_FILE,
			),
		).toEqual({
			gatewayUrl: "http://127.0.0.1:4100",
			envFile: INSTALL_ENV_FILE,
			defaultChatId: "42",
		});
		expect(
			loadTgMcpConfig(
				{
					TG_GATEWAY_URL: "",
					TG_GATEWAY_ENV_FILE: "",
					TG_DEFAULT_CHAT_ID: "",
				},
				"",
			),
		).toEqual({
			gatewayUrl: DEFAULT_GATEWAY_URL,
			envFile: "",
			defaultChatId: undefined,
		});
	});
});
