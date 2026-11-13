vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import { HandleUpdateUseCase } from "../../src/application/handle-update.ts";
import type { IncomingUpdate } from "../../src/domain/entities/message.ts";
import { HandlerRegistry } from "../../src/infrastructure/handler-registry.ts";
import { logger } from "../../src/infrastructure/logger.ts";

function makeTextUpdate(text: string): IncomingUpdate {
	return {
		update_id: 1,
		message: {
			message_id: 10,
			text,
			chat: { id: 100, type: "private" },
			from: { id: 200, username: "testuser" },
		},
	};
}

function makeCallbackUpdate(data: string): IncomingUpdate {
	return {
		update_id: 2,
		callback_query: {
			id: "cb-1",
			data,
			from: { id: 200, username: "testuser" },
			message: { message_id: 10, chat: { id: 100 } },
		},
	};
}

function makeVoiceUpdateWithVoice(): IncomingUpdate {
	return {
		update_id: 4,
		message: {
			message_id: 12,
			text: undefined,
			chat: { id: 100, type: "private" },
			from: { id: 200, username: "testuser" },
			voice: { file_id: "xxx", duration: 5 },
		},
	};
}

function makeAudioUpdate(): IncomingUpdate {
	return {
		update_id: 5,
		message: {
			message_id: 13,
			text: undefined,
			chat: { id: 100, type: "private" },
			from: { id: 200, username: "testuser" },
			audio: { file_id: "yyy", duration: 10 },
		},
	};
}

function makeOnlyCallbackUpdate(data: string): IncomingUpdate {
	return {
		update_id: 6,
		callback_query: {
			id: "cb-only",
			data,
			from: { id: 200, username: "testuser" },
		},
	};
}

describe("HandleUpdateUseCase", () => {
	let registry: HandlerRegistry;
	let useCase: HandleUpdateUseCase;

	beforeEach(() => {
		registry = new HandlerRegistry();
		useCase = new HandleUpdateUseCase(registry);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
		);
	});

	describe("routing logs", () => {
		it("registra la ruta del comando", async () => {
			const infoSpy = vi.spyOn(logger, "info");
			registry.register("/start", "https://hook.example.com/start");
			await useCase.execute(makeTextUpdate("/start hello"));

			expect(infoSpy).toHaveBeenCalledWith(
				"update routing",
				expect.objectContaining({
					update_id: 1,
					type: "message",
					chatId: "100",
					route: "/start",
					text: "/start hello",
				}),
			);
		});

		it("registra la ruta del handler por defecto", async () => {
			const infoSpy = vi.spyOn(logger, "info");
			registry.register("__default__", "https://hook.example.com/default");
			await useCase.execute(makeTextUpdate("hello"));

			expect(infoSpy).toHaveBeenCalledWith(
				"update routing",
				expect.objectContaining({ route: "__default__", chatId: "100" }),
			);
		});

		it("registra los descartes por handler inexistente y por contenido vacío", async () => {
			const infoSpy = vi.spyOn(logger, "info");
			await useCase.execute(makeTextUpdate("/unknown"));
			await useCase.execute(makeTextUpdate(""));

			expect(infoSpy).toHaveBeenCalledWith(
				"update routing",
				expect.objectContaining({ route: "dropped", reason: "no-handler" }),
			);
			expect(infoSpy).toHaveBeenCalledWith(
				"update routing",
				expect.objectContaining({ route: "dropped", reason: "empty" }),
			);
		});

		it("registra callbacks con su tipo y ruta", async () => {
			const infoSpy = vi.spyOn(logger, "info");
			registry.register("/approve", "https://hook.example.com/approve");
			await useCase.execute(makeCallbackUpdate("/approve:123"));

			expect(infoSpy).toHaveBeenCalledWith(
				"update routing",
				expect.objectContaining({
					update_id: 2,
					type: "callback",
					chatId: "100",
					route: "/approve",
				}),
			);
		});
	});

	describe("text commands", () => {
		it("forwards update when text matches registered command", async () => {
			registry.register("/start", "https://hook.example.com/start");
			const update = makeTextUpdate("/start");

			const handled = await useCase.execute(update);

			expect(handled).toBe(true);
			expect(fetch).toHaveBeenCalledWith(
				"https://hook.example.com/start",
				expect.objectContaining({
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(update),
				}),
			);
		});

		it("strips @username from command before matching", async () => {
			registry.register("/f2b", "https://hook.example.com/f2b");
			const update = makeTextUpdate("/f2b@my_bot arg1 arg2");

			const handled = await useCase.execute(update);

			expect(handled).toBe(true);
			expect(fetch).toHaveBeenCalledWith(
				"https://hook.example.com/f2b",
				expect.anything(),
			);
		});

		it("returns false if no handler matches", async () => {
			const update = makeTextUpdate("/unknown");

			const handled = await useCase.execute(update);

			expect(handled).toBe(false);
		});

		it("forwards to __default__ when no specific handler and message has text", async () => {
			registry.register("__default__", "https://hook.example.com/default");
			const update = makeTextUpdate("hello there");

			const handled = await useCase.execute(update);

			expect(handled).toBe(true);
			expect(fetch).toHaveBeenCalledWith(
				"https://hook.example.com/default",
				expect.anything(),
			);
		});

		it("does not forward empty text to default", async () => {
			registry.register("__default__", "https://hook.example.com/default");
			const update = makeTextUpdate("");

			const handled = await useCase.execute(update);

			expect(handled).toBe(false);
		});

		it("forwards to __default__ when update has voice but no text", async () => {
			registry.register("__default__", "https://hook.example.com/default");
			const update = makeVoiceUpdateWithVoice();

			const handled = await useCase.execute(update);

			expect(handled).toBe(true);
		});

		it("forwards to __default__ when update has audio but no text", async () => {
			registry.register("__default__", "https://hook.example.com/default");
			const update = makeAudioUpdate();

			const handled = await useCase.execute(update);

			expect(handled).toBe(true);
		});

		it("does not forward to __default__ for message without text, voice, or audio", async () => {
			registry.register("__default__", "https://hook.example.com/default");
			const update = makeTextUpdate("");
			(update.message as Record<string, unknown>).voice = undefined;

			const handled = await useCase.execute(update);

			expect(handled).toBe(false);
		});

		it("matches command without arguments", async () => {
			registry.register("/help", "https://hook.example.com/help");
			const update = makeTextUpdate("/help");

			const handled = await useCase.execute(update);

			expect(handled).toBe(true);
		});

		it("matches command with trailing whitespace", async () => {
			registry.register("/ping", "https://hook.example.com/ping");
			const update = makeTextUpdate("/ping   ");

			const handled = await useCase.execute(update);

			expect(handled).toBe(true);
		});
	});

	describe("callback queries", () => {
		it("forwards callback when data starts with a slash command", async () => {
			registry.register("/approve", "https://hook.example.com/approve");
			const update = makeCallbackUpdate("/approve:user_123");

			const handled = await useCase.execute(update);

			expect(handled).toBe(true);
			expect(fetch).toHaveBeenCalledWith(
				"https://hook.example.com/approve",
				expect.anything(),
			);
		});

		it("forwards callback with simple word prefix", async () => {
			registry.register("review", "https://hook.example.com/review");
			const update = makeCallbackUpdate("review:photo_42");

			const handled = await useCase.execute(update);

			expect(handled).toBe(true);
			expect(fetch).toHaveBeenCalledWith(
				"https://hook.example.com/review",
				expect.anything(),
			);
		});

		it("returns false for unregistered callback data", async () => {
			const update = makeCallbackUpdate("some_unknown_action");

			const handled = await useCase.execute(update);

			expect(handled).toBe(false);
		});

		it("returns false for empty callback data", async () => {
			const update = makeCallbackUpdate("");

			const handled = await useCase.execute(update);

			expect(handled).toBe(false);
		});

		it("handles callback_query without message field", async () => {
			registry.register("inline", "https://hook.example.com/inline");
			const update = makeOnlyCallbackUpdate("inline:action");

			const handled = await useCase.execute(update);

			expect(handled).toBe(true);
		});

		it("prefers slash match over word match in callback data", async () => {
			registry.register("/cmd", "https://hook.example.com/cmd");
			registry.register("cmd_word", "https://hook.example.com/word");
			const update = makeCallbackUpdate("/cmd:action");

			const handled = await useCase.execute(update);

			expect(handled).toBe(true);
			expect(fetch).toHaveBeenCalledWith(
				"https://hook.example.com/cmd",
				expect.anything(),
			);
		});

		it("returns false for callback without data", async () => {
			const update = makeCallbackUpdate("");
			(update.callback_query as Record<string, unknown>).data = undefined;

			const handled = await useCase.execute(update);

			expect(handled).toBe(false);
		});

		// El toque de un botón inline trae como data el comando que el usuario
		// habría tecleado. Sin handler específico debe seguir el mismo camino
		// que un mensaje: al handler por defecto. Antes se descartaba, así que
		// los botones inline de un comando registrado por otro servicio no
		// hacían nada al pulsarlos.
		it("forwards callback to __default__ when no specific handler matches", async () => {
			registry.register("__default__", "https://hook.example.com/default");
			const update = makeCallbackUpdate(
				"/approve 3f2a1c9e-0b7d-4e5f-9a11-8c2de6f4b7a0",
			);

			const handled = await useCase.execute(update);

			expect(handled).toBe(true);
			expect(fetch).toHaveBeenCalledWith(
				"https://hook.example.com/default",
				expect.anything(),
			);
		});

		it("still prefers a specific prefix handler over __default__", async () => {
			registry.register("__default__", "https://hook.example.com/default");
			registry.register("/approve", "https://hook.example.com/approve");
			const update = makeCallbackUpdate("/approve 3f2a1c9e-0b7d-4e5f");

			const handled = await useCase.execute(update);

			expect(handled).toBe(true);
			expect(fetch).toHaveBeenCalledWith(
				"https://hook.example.com/approve",
				expect.anything(),
			);
			expect(fetch).toHaveBeenCalledTimes(1);
		});

		it("does not forward empty callback data to __default__", async () => {
			registry.register("__default__", "https://hook.example.com/default");
			const update = makeCallbackUpdate("");

			const handled = await useCase.execute(update);

			expect(handled).toBe(false);
			expect(fetch).not.toHaveBeenCalled();
		});
	});

	describe("enlaces", () => {
		// Sin la función de descargas un enlace es texto como cualquier otro: llega
		// al webhook del handler, no se intercepta ni lanza procesos.
		it.each([
			"https://youtube.com/watch?v=abc",
			"https://soundcloud.com/artist/track",
			"https://www.tiktok.com/@user/video/123",
		])("reenvía %s al handler por defecto", async (link) => {
			registry.register("__default__", "https://hook.example.com/default");

			const handled = await useCase.execute(makeTextUpdate(link));

			expect(handled).toBe(true);
			expect(fetch).toHaveBeenCalledWith(
				"https://hook.example.com/default",
				expect.anything(),
			);
		});

		it("no lanza ningún proceso para los enlaces", async () => {
			registry.register("__default__", "https://hook.example.com/default");

			await useCase.execute(
				makeTextUpdate("https://youtu.be/abc123"),
			);

			expect(spawn).not.toHaveBeenCalled();
		});

		it("un enlace en un chat con handler de comando también cae al default", async () => {
			registry.register("__default__", "https://hook.example.com/default");
			registry.register("/pedido", "https://hook.example.com/pedido");

			await useCase.execute(
				makeTextUpdate("mira https://vimeo.com/123"),
			);

			expect(fetch).toHaveBeenCalledTimes(1);
			expect(fetch).toHaveBeenCalledWith(
				"https://hook.example.com/default",
				expect.anything(),
			);
		});
	});

	describe("forward delegation", () => {
		it("passes forwardTimeoutMs to the underlying forwarder", async () => {
			const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
			const customUseCase = new HandleUpdateUseCase(registry, {
				forwardTimeoutMs: 4321,
			});
			registry.register("/start", "https://hook.example.com/start");

			await customUseCase.execute(makeTextUpdate("/start"));

			expect(timeoutSpy).toHaveBeenCalledWith(4321);
			timeoutSpy.mockRestore();
		});

		it("does not throw when forward fails", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockRejectedValue(new Error("network error")),
			);
			registry.register("/start", "https://hook.example.com/start");

			await expect(
				useCase.execute(makeTextUpdate("/start")),
			).resolves.toBe(true);
		});
	});
});
