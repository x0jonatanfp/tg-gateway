import { describe, it, expect } from "vitest";
import { redactWebhookCredentials } from "../../src/infrastructure/redact.ts";

describe("logger", () => {
	it("creates logger module without error", async () => {
		const mod = await import("../../src/infrastructure/logger.ts");
		expect(mod.logger).toBeDefined();
		expect(typeof mod.logger.info).toBe("function");
		expect(typeof mod.logger.error).toBe("function");
		expect(typeof mod.logger.warn).toBe("function");
		expect(typeof mod.logger.debug).toBe("function");
	});

	it("redacts webhook credentials through the shared helper", () => {
		expect(redactWebhookCredentials("http://usuario:secreto@localhost/path"))
			.toBe("http://***:***@localhost/path");
		expect(redactWebhookCredentials("http://usuario@localhost/path"))
			.toBe("http://***@localhost/path");
		expect(redactWebhookCredentials("http://localhost/path"))
			.toBe("http://localhost/path");
		expect(redactWebhookCredentials("not a url")).toBe("not a url");
	});

	it("no añade requestId en líneas sin contexto", async () => {
		const { addRequestId } = await import(
			"../../src/infrastructure/logger.ts"
		);
		const info: Record<string, unknown> = { level: "info", message: "x" };

		addRequestId(info as never);

		// El formato de consola añade los metadatos que sobren: si `requestId`
		// existe aunque sea `undefined`, cada línea sale con un " {}" de más.
		expect(Object.keys(info)).toEqual(["level", "message"]);
	});

	it("inyecta el requestId cuando hay contexto", async () => {
		const { addRequestId } = await import(
			"../../src/infrastructure/logger.ts"
		);
		const { runWithRequestId } = await import(
			"../../src/infrastructure/request-context.ts"
		);
		const info: Record<string, unknown> = { level: "info", message: "x" };

		runWithRequestId("req-logger", () => {
			addRequestId(info as never);
		});

		expect(info.requestId).toBe("req-logger");
	});
});
