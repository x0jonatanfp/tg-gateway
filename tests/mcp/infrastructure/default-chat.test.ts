import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatResolutionError } from "../../../src/mcp/domain/chat-resolver.ts";
import { createDefaultChatResolver } from "../../../src/mcp/infrastructure/default-chat.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs.length = 0;
});

function envFile(content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "tg-mcp-chat-"));
	dirs.push(dir);
	const file = join(dir, "tg.env");
	writeFileSync(file, content);
	return file;
}

describe("chat por defecto", () => {
	it("el chat explícito manda sobre todo lo demás", () => {
		const resolver = createDefaultChatResolver({
			envFile: "/no/existe",
			envDefaultChatId: "22",
		});
		expect(resolver.resolve("33")).toBe("33");
	});

	it("TG_DEFAULT_CHAT_ID tiene prioridad sobre el fichero", () => {
		const file = envFile("TG_ALLOWED_CHATS=111,222\n");
		const resolver = createDefaultChatResolver({
			envFile: file,
			envDefaultChatId: "999",
		});
		expect(resolver.resolve()).toBe("999");
	});

	it("lee el primer valor de TG_ALLOWED_CHATS y nada más", () => {
		const file = envFile(
			[
				"# comentario",
				"TG_BOT_TOKEN=no-se-usa",
				'TG_ALLOWED_CHATS="111, 222"',
				"OTRA_CLAVE=333",
			].join("\n"),
		);
		const resolver = createDefaultChatResolver({ envFile: file });
		expect(resolver.resolve()).toBe("111");
	});

	it("salta elementos vacíos de la lista", () => {
		const file = envFile("TG_ALLOWED_CHATS=, ,444\n");
		const resolver = createDefaultChatResolver({ envFile: file });
		expect(resolver.resolve()).toBe("444");
	});

	it("falla cerrado y con mensaje accionable si no hay chat", () => {
		const resolver = createDefaultChatResolver({ envFile: "/no/existe" });
		expect(() => resolver.resolve()).toThrow(ChatResolutionError);
		expect(() => resolver.resolve()).toThrow("TG_DEFAULT_CHAT_ID");
	});
});
