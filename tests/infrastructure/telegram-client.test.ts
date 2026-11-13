import { describe, it, expect, vi, beforeEach } from "vitest";
import { TelegramClient } from "../../src/infrastructure/telegram-client.ts";
import type { OutgoingMessage } from "../../src/domain/entities/message.ts";
import { logger } from "../../src/infrastructure/logger.ts";

function okResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function rateLimitResponse(retryAfter = 2): Response {
	return new Response(
		JSON.stringify({
			ok: false,
			parameters: { retry_after: retryAfter },
		}),
		{ status: 429, headers: { "Content-Type": "application/json" } },
	);
}

describe("TelegramClient", () => {
	let client: TelegramClient;

	beforeEach(() => {
		client = new TelegramClient("test:token");
		vi.stubGlobal("fetch", vi.fn());
	});

	describe("sendMessage", () => {
		const msg: OutgoingMessage = { chatId: "123", text: "hello" };

		it("sends JSON request to Telegram and returns SendResult", async () => {
			vi.mocked(fetch).mockResolvedValue(
				okResponse({
					ok: true,
					result: { message_id: 42, chat: { id: 123 } },
				}),
			);

			const result = await client.sendMessage(msg);

			expect(result).toEqual({ chatId: 123, messageId: 42 });
			expect(fetch).toHaveBeenCalledWith(
				"https://api.telegram.org/bottest:token/sendMessage",
				expect.objectContaining({
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						chat_id: "123",
						text: "hello",
						parse_mode: "Markdown",
					}),
				}),
			);
		});

		it("emits a successful operation log with messageId, duration and text", async () => {
			const infoSpy = vi.spyOn(logger, "info");
			vi.mocked(fetch).mockResolvedValue(
				okResponse({
					ok: true,
					result: { message_id: 42, chat: { id: 123 } },
				}),
			);

			await client.sendMessage({ ...msg, text: "hello" });

			expect(infoSpy).toHaveBeenCalledWith(
				"telegram send",
				expect.objectContaining({
					method: "sendMessage",
					chatId: "123",
					ok: true,
					messageId: 42,
					ms: expect.any(Number),
					text: "hello",
				}),
			);
		});

		it("emits a failed operation log when Telegram rejects the message", async () => {
			const warnSpy = vi.spyOn(logger, "warn");
			vi.mocked(fetch).mockResolvedValue(
				new Response(JSON.stringify({ ok: false, description: "chat not found" }), {
					status: 400,
				}),
			);

			await client.sendMessage({ ...msg, text: "failed message" });

			expect(warnSpy).toHaveBeenCalledWith(
				"telegram send",
				expect.objectContaining({
					method: "sendMessage",
					chatId: "123",
					ok: false,
					ms: expect.any(Number),
					text: "failed message",
				}),
			);
		});
		it("retries on 429 with backoff", async () => {
			vi.mocked(fetch)
				.mockResolvedValueOnce(rateLimitResponse(0))
				.mockResolvedValueOnce(
					okResponse({
						ok: true,
						result: { message_id: 1, chat: { id: 123 } },
					}),
				);

			const result = await client.sendMessage(msg);

			expect(result).toEqual({ chatId: 123, messageId: 1 });
			expect(fetch).toHaveBeenCalledTimes(2);
		});


		it("retries up to 3 times on 429", async () => {
			vi.mocked(fetch)
				.mockResolvedValueOnce(rateLimitResponse(0))
				.mockResolvedValueOnce(rateLimitResponse(0))
				.mockResolvedValueOnce(rateLimitResponse(0))
				.mockResolvedValueOnce(
					okResponse({
						ok: true,
						result: { message_id: 1, chat: { id: 123 } },
					}),
				);

			const result = await client.sendMessage(msg);

			expect(result).toEqual({ chatId: 123, messageId: 1 });
			expect(fetch).toHaveBeenCalledTimes(4);
		});

		it("retries without parse_mode on failure", async () => {
			vi.mocked(fetch)
				.mockResolvedValueOnce(
					new Response(
						JSON.stringify({
							ok: false,
							error_code: 400,
							description:
								"Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 3",
						}),
						{ status: 400 },
					),
				)
				.mockResolvedValueOnce(
					okResponse({
						ok: true,
						result: { message_id: 5, chat: { id: 123 } },
					}),
				);

			const result = await client.sendMessage(msg);

			expect(result).toEqual({ chatId: 123, messageId: 5 });
			const calls = vi.mocked(fetch).mock.calls;
			expect(calls[1]![1]!.body).not.toContain("parse_mode");
		});

		it("no reintenta sin parse_mode si el error no es de formato (chat not found)", async () => {
			vi.mocked(fetch).mockResolvedValue(
				new Response(
					JSON.stringify({
						ok: false,
						error_code: 400,
						description: "Bad Request: chat not found",
					}),
					{ status: 400 },
				),
			);

			const result = await client.sendMessage(msg);

			expect(result).toBeNull();
			expect(fetch).toHaveBeenCalledTimes(1);
		});

		it("includes reply_markup when provided", async () => {
			const markup = { inline_keyboard: [] };
			vi.mocked(fetch).mockResolvedValue(
				okResponse({
					ok: true,
					result: { message_id: 1, chat: { id: 123 } },
				}),
			);

			await client.sendMessage({ ...msg, replyMarkup: markup });

			const body = JSON.parse(
				(vi.mocked(fetch).mock.calls[0]![1]!.body as string),
			);
			expect(body.reply_markup).toEqual(markup);
		});
	});
	describe("sendPhoto", () => {
		it("emits a caption operation log for photo success", async () => {
			const { writeFileSync, unlinkSync } = await import("node:fs");
			const infoSpy = vi.spyOn(logger, "info");
			const tmpFile = "/tmp/test-photo-log.jpg";
			writeFileSync(tmpFile, Buffer.alloc(16));
			vi.mocked(fetch).mockResolvedValue(
				okResponse({ ok: true, result: { message_id: 11, chat: { id: 42 } } }),
			);

			await client.sendPhoto({ chatId: "42", filePath: tmpFile }, "photo caption");

			expect(infoSpy).toHaveBeenCalledWith(
				"telegram send",
				expect.objectContaining({
					method: "sendPhoto",
					ok: true,
					messageId: 11,
					caption: "photo caption",
				}),
			);
			unlinkSync(tmpFile);
		});

		it("sends multipart form-data for a real file", async () => {
			const { writeFileSync, unlinkSync } = await import("node:fs");
			const tmpFile = "/tmp/test-photo.jpg";
			writeFileSync(tmpFile, Buffer.alloc(64));

			vi.mocked(fetch).mockResolvedValue(
				okResponse({
					ok: true,
					result: { message_id: 10, chat: { id: 42 } },
				}),
			);

			const result = await client.sendPhoto({
				chatId: "42",
				filePath: tmpFile,
				caption: "caption",
			});

			expect(result).toEqual({ chatId: 42, messageId: 10 });

			const callUrl = vi.mocked(fetch).mock.calls[0]![0] as string;
			expect(callUrl).toContain("sendPhoto");

			unlinkSync(tmpFile);
		});

		it("returns null for non-existent file", async () => {
			const result = await client.sendPhoto({
				chatId: "42",
				filePath: "/nonexistent/photo.jpg",
				caption: "caption",
			});

			expect(result).toBeNull();
		});
	});


	describe("sendVideo", () => {
		it("sends multipart form-data for a real file", async () => {
			const { writeFileSync, unlinkSync } = await import("node:fs");
			const tmpFile = "/tmp/test-video.mp4";
			writeFileSync(tmpFile, Buffer.alloc(128));

			vi.mocked(fetch).mockResolvedValue(
				okResponse({
					ok: true,
					result: { message_id: 20, chat: { id: 7 } },
				}),
			);

			const result = await client.sendVideo({
				chatId: "7",
				filePath: tmpFile,
				caption: "vid caption",
			});

			expect(result).toEqual({ chatId: 7, messageId: 20 });

			const callUrl = vi.mocked(fetch).mock.calls[0]![0] as string;
			expect(callUrl).toContain("sendVideo");

			unlinkSync(tmpFile);
		});

		it("returns null for non-existent file", async () => {
			const result = await client.sendVideo({
				chatId: "42",
				filePath: "/nonexistent/video.mp4",
				caption: "caption",
			});

			expect(result).toBeNull();
		});

		it("sends video without caption", async () => {
			const { writeFileSync, unlinkSync } = await import("node:fs");
			const tmpFile = "/tmp/test-video-nocap.mp4";
			writeFileSync(tmpFile, Buffer.alloc(32));

			vi.mocked(fetch).mockResolvedValue(
				okResponse({
					ok: true,
					result: { message_id: 30, chat: { id: 9 } },
				}),
			);

			const result = await client.sendVideo({
				chatId: "9",
				filePath: tmpFile,
			});

			expect(result).toEqual({ chatId: 9, messageId: 30 });

			unlinkSync(tmpFile);
		});
	});
	describe("sendMediaGroup", () => {
		it("sends multipart form-data with every file and returns the first message", async () => {
			const { writeFileSync, unlinkSync } = await import("node:fs");
			const fileA = "/tmp/test-album-a.png";
			const fileB = "/tmp/test-album-b.png";
			writeFileSync(fileA, Buffer.alloc(64));
			writeFileSync(fileB, Buffer.alloc(64));

			vi.mocked(fetch).mockResolvedValue(
				okResponse({
					ok: true,
					result: [
						{ message_id: 50, chat: { id: 7 } },
						{ message_id: 51, chat: { id: 7 } },
					],
				}),
			);

			const result = await client.sendMediaGroup({
				chatId: "7",
				filePaths: [fileA, fileB],
				caption: "the post",
			});

			expect(result).toEqual({ chatId: 7, messageId: 50 });

			const callUrl = vi.mocked(fetch).mock.calls[0]![0] as string;
			expect(callUrl).toContain("sendMediaGroup");
			const body = (vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as Buffer;
			const text = body.toString("utf-8");
			expect(text).toContain("attach://photo0");
			expect(text).toContain("attach://photo1");
			expect(text).toContain('name="photo0"');
			expect(text).toContain('name="photo1"');
			expect(text).toContain('"caption":"the post"');

			unlinkSync(fileA);
			unlinkSync(fileB);
		});

		it("returns null without calling Telegram when count is out of range", async () => {
			const result = await client.sendMediaGroup({
				chatId: "7",
				filePaths: ["/tmp/only-one.png"],
			});

			expect(result).toBeNull();
			expect(fetch).not.toHaveBeenCalled();
		});

		it("returns null for a non-existent file", async () => {
			const result = await client.sendMediaGroup({
				chatId: "7",
				filePaths: ["/nonexistent/a.png", "/nonexistent/b.png"],
			});

			expect(result).toBeNull();
		});
	});

	describe("editReplyMarkup", () => {
		it("devuelve la descripción real de Telegram cuando rechaza la orden", async () => {
			vi.mocked(fetch).mockResolvedValue(
				new Response(
					JSON.stringify({
						ok: false,
						description: "Bad Request: message to edit not found",
					}),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				),
			);

			await expect(client.editReplyMarkup("123", 5, {})).resolves.toEqual({
				ok: false,
				error: "Bad Request: message to edit not found",
			});
		});

		it("emits operation logs for ignored Telegram calls", async () => {
			const warnSpy = vi.spyOn(logger, "warn");
			vi.mocked(fetch).mockRejectedValue(new Error("network"));

			await client.editReplyMarkup("1", 2, {});
			await client.deleteMessage("1", 3);
			await client.answerCallbackQuery("cb-1");
			await client.sendChatAction("1", "typing");

			expect(warnSpy.mock.calls.filter(([message]) => message === "telegram send")).toHaveLength(4);
		});

		it("sends correct request", async () => {
			vi.mocked(fetch).mockResolvedValue(okResponse({ ok: true }));

			await client.editReplyMarkup("123", 5, { inline_keyboard: [] });

			expect(fetch).toHaveBeenCalledWith(
				"https://api.telegram.org/bottest:token/editMessageReplyMarkup",
				expect.objectContaining({
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						chat_id: "123",
						message_id: 5,
						reply_markup: { inline_keyboard: [] },
					}),
				}),
			);
		});

		it("does not throw on network error", async () => {
			vi.mocked(fetch).mockRejectedValue(new Error("network"));

			await expect(
				client.editReplyMarkup("123", 5, {}),
			).resolves.toEqual({ ok: false, error: expect.stringContaining("network") });
		});
	});

	describe("deleteMessage", () => {
		it("devuelve la descripción real de Telegram cuando no puede borrar", async () => {
			vi.mocked(fetch).mockResolvedValue(
				new Response(
					JSON.stringify({
						ok: false,
						description: "Bad Request: message to delete not found",
					}),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				),
			);

			await expect(client.deleteMessage("123", 5)).resolves.toEqual({
				ok: false,
				error: "Bad Request: message to delete not found",
			});
		});

		it("sends correct request", async () => {
			vi.mocked(fetch).mockResolvedValue(okResponse({ ok: true }));

			await client.deleteMessage("123", 5);

			expect(fetch).toHaveBeenCalledWith(
				"https://api.telegram.org/bottest:token/deleteMessage",
				expect.anything(),
			);
		});

		it("does not throw on error", async () => {
			vi.mocked(fetch).mockRejectedValue(new Error("network"));

			await expect(
				client.deleteMessage("123", 5),
			).resolves.toEqual({ ok: false, error: expect.stringContaining("network") });
		});

		it("does not throw on non-ok status", async () => {
			vi.mocked(fetch).mockResolvedValue(
				new Response(null, { status: 400 }),
			);

			await expect(
				client.deleteMessage("123", 5),
			).resolves.toEqual({ ok: false, error: "HTTP 400" });
		});
	});

	describe("answerCallbackQuery", () => {
		it("sends correct request with text", async () => {
			vi.mocked(fetch).mockResolvedValue(okResponse({ ok: true }));

			await client.answerCallbackQuery("cb-1", "done");

			const body = JSON.parse(
				(vi.mocked(fetch).mock.calls[0]![1]!.body as string),
			);
			expect(body.callback_query_id).toBe("cb-1");
			expect(body.text).toBe("done");
		});

		it("sends correct request without text", async () => {
			vi.mocked(fetch).mockResolvedValue(okResponse({ ok: true }));

			await client.answerCallbackQuery("cb-2");

			const body = JSON.parse(
				(vi.mocked(fetch).mock.calls[0]![1]!.body as string),
			);
			expect(body.callback_query_id).toBe("cb-2");
			expect(body.text).toBe("");
		});

		it("does not throw on network error", async () => {
			vi.mocked(fetch).mockRejectedValue(new Error("network"));

			await expect(
				client.answerCallbackQuery("cb-3"),
			).resolves.toBeUndefined();
		});
	});

	describe("getMe", () => {
		it("returns bot id from API", async () => {
			vi.mocked(fetch).mockResolvedValue(
				okResponse({ ok: true, result: { id: 999, is_bot: true } }),
			);

			const id = await client.getMe();

			expect(id).toBe(999);
		});

		it("returns null on error", async () => {
			vi.mocked(fetch).mockRejectedValue(new Error("fail"));

			const id = await client.getMe();

			expect(id).toBeNull();
		});

		it("caches result and does not call API twice", async () => {
			vi.mocked(fetch).mockResolvedValue(
				okResponse({ ok: true, result: { id: 555, is_bot: true } }),
			);

			await client.getMe();
			await client.getMe();

			expect(fetch).toHaveBeenCalledTimes(1);
		});
	});

	describe("parseResult", () => {
		it("returns null when response.ok is false", async () => {
			vi.mocked(fetch).mockResolvedValue(
				new Response(JSON.stringify({ ok: false }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);

			const result = await client.sendMessage({
				chatId: "1",
				text: "hi",
			});

			expect(result).toBeNull();
		});
	});

	describe("network resilience", () => {
		const transientNetworkError = () =>
			new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });

		it("passes an AbortSignal to each fetch call", async () => {
			vi.mocked(fetch).mockResolvedValue(
				okResponse({
					ok: true,
					result: { message_id: 1, chat: { id: 1 } },
				}),
			);

			await client.sendMessage({ chatId: "1", text: "hi" });

			const init = vi.mocked(fetch).mock.calls[0]?.[1];
			expect(init?.signal).toBeInstanceOf(AbortSignal);
		});

		it("retries transient network errors and eventually succeeds", async () => {
			vi.mocked(fetch)
				.mockRejectedValueOnce(transientNetworkError())
				.mockRejectedValueOnce(transientNetworkError())
				.mockResolvedValueOnce(
					okResponse({
						ok: true,
						result: { message_id: 7, chat: { id: 1 } },
					}),
				);

			const result = await client.sendMessage({ chatId: "1", text: "hi" });

			expect(result).toEqual({ chatId: 1, messageId: 7 });
			expect(fetch).toHaveBeenCalledTimes(3);
		});

		it("gives up after the configured number of network retries", async () => {
			const limited = new TelegramClient("test:token", { retries: 2 });

			vi.mocked(fetch).mockRejectedValue(transientNetworkError());

			const result = await limited.sendMessage({ chatId: "1", text: "hi" });

			expect(result).toBeNull();
			expect(fetch).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
		});

		it("does not retry errors that are not transient", async () => {
			vi.mocked(fetch).mockRejectedValue(new Error("plain not-network"));

			const result = await client.sendMessage({ chatId: "1", text: "hi" });

			expect(result).toBeNull();
			expect(fetch).toHaveBeenCalledTimes(1);
		});

		it("does not retry sendPhoto on transient errors (multipart opt-out)", async () => {
			const { writeFileSync, unlinkSync } = await import("node:fs");
			const tmpFile = "/tmp/test-photo-no-retry.jpg";
			writeFileSync(tmpFile, Buffer.alloc(64));
			vi.mocked(fetch).mockRejectedValue(transientNetworkError());

			const result = await client.sendPhoto({
				chatId: "42",
				filePath: tmpFile,
			});

			expect(result).toBeNull();
			expect(fetch).toHaveBeenCalledTimes(1);
			unlinkSync(tmpFile);
		});

		it("does not retry sendVideo on transient errors (multipart opt-out)", async () => {
			const { writeFileSync, unlinkSync } = await import("node:fs");
			const tmpFile = "/tmp/test-video-no-retry.mp4";
			writeFileSync(tmpFile, Buffer.alloc(64));
			vi.mocked(fetch).mockRejectedValue(transientNetworkError());

			const result = await client.sendVideo({
				chatId: "7",
				filePath: tmpFile,
			});

			expect(result).toBeNull();
			expect(fetch).toHaveBeenCalledTimes(1);
			unlinkSync(tmpFile);
		});

		it("resets the network retry counter when retrying from a 429", async () => {
			// 1st fetch: 429 (rate=0 → recurse with rate=1, net=0)
			// 2nd fetch: ECONNRESET (net=0 → network retry)
			// 3rd fetch: 200 OK
			vi.mocked(fetch)
				.mockResolvedValueOnce(rateLimitResponse(0))
				.mockRejectedValueOnce(transientNetworkError())
				.mockResolvedValueOnce(
					okResponse({
						ok: true,
						result: { message_id: 9, chat: { id: 1 } },
					}),
				);

			const result = await client.sendMessage({ chatId: "1", text: "hi" });

			expect(result).toEqual({ chatId: 1, messageId: 9 });
			expect(fetch).toHaveBeenCalledTimes(3);
		});

		it("constructor option retries=0 disables network retry entirely", async () => {
			const noRetry = new TelegramClient("test:token", { retries: 0 });
			vi.mocked(fetch)
				.mockRejectedValueOnce(transientNetworkError())
				.mockResolvedValueOnce(
					okResponse({
						ok: true,
						result: { message_id: 1, chat: { id: 1 } },
					}),
				);

			// The retry call shouldn't happen; sendMessage returns null on
			// the failure. Two calls would only happen if retry kicked in,
			// which it shouldn't.
			const result = await noRetry.sendMessage({ chatId: "1", text: "hi" });

			expect(result).toBeNull();
			expect(fetch).toHaveBeenCalledTimes(1);
		});

		it("TimeoutError counts as transient", async () => {
			const timeoutErr = Object.assign(
				new Error("aborted"),
				{ name: "TimeoutError" },
			);
			vi.mocked(fetch)
				.mockRejectedValueOnce(timeoutErr)
				.mockResolvedValueOnce(
					okResponse({
						ok: true,
						result: { message_id: 1, chat: { id: 1 } },
					}),
				);

			const result = await client.sendMessage({ chatId: "1", text: "hi" });
			expect(result).toEqual({ chatId: 1, messageId: 1 });
			expect(fetch).toHaveBeenCalledTimes(2);
		});

		it("AbortError counts as transient", async () => {
			const abortErr = Object.assign(
				new Error("aborted"),
				{ name: "AbortError" },
			);
			vi.mocked(fetch)
				.mockRejectedValueOnce(abortErr)
				.mockResolvedValueOnce(
					okResponse({
						ok: true,
						result: { message_id: 1, chat: { id: 1 } },
					}),
				);

			const result = await client.sendMessage({ chatId: "1", text: "hi" });
			expect(result).toEqual({ chatId: 1, messageId: 1 });
			expect(fetch).toHaveBeenCalledTimes(2);
		});
	});

	describe("timeout overrides", () => {
		it("uses the override from options.timeouts when the method is configured", async () => {
			const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
			const clientWithOverride = new TelegramClient("test:token", {
				timeouts: { sendMessage: 7000 },
			});
			vi.mocked(fetch).mockResolvedValue(
				okResponse({
					ok: true,
					result: { message_id: 1, chat: { id: 1 } },
				}),
			);

			await clientWithOverride.sendMessage({ chatId: "1", text: "hi" });

			expect(timeoutSpy).toHaveBeenCalledWith(7000);
			timeoutSpy.mockRestore();
		});

		it("falls back to the built-in default when the method has no override", async () => {
			const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
			const clientWithOverride = new TelegramClient("test:token", {
				timeouts: { sendMessage: 7000 },
			});
			vi.mocked(fetch).mockResolvedValue(
				okResponse({
					ok: true,
					result: { message_id: 1, chat: { id: 1 } },
				}),
			);

			await clientWithOverride.deleteMessage("1", 1);

			// deleteMessage default es 15000 (no aparece en overrides)
			expect(timeoutSpy).toHaveBeenCalledWith(15_000);
			timeoutSpy.mockRestore();
		});
	});

	describe("circuit breaker", () => {
		const transientErr = () =>
			new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });

		it("keeps the breaker closed after successes", async () => {
			vi.mocked(fetch).mockResolvedValue(
				okResponse({ ok: true, result: { message_id: 1, chat: { id: 1 } } }),
			);
			await client.sendMessage({ chatId: "1", text: "hi" });
			await client.sendMessage({ chatId: "1", text: "hi again" });
			expect(fetch).toHaveBeenCalledTimes(2);
		});

		it("trips open after `threshold` consecutive terminal transient failures", async () => {
			const noRetry = new TelegramClient("test:token", {
				retries: 0,
				circuitBreakerThreshold: 3,
				circuitBreakerCooldownMs: 30_000,
			});
			vi.mocked(fetch).mockRejectedValue(transientErr());

			await noRetry.deleteMessage("1", 1);
			await noRetry.deleteMessage("1", 2);
			await noRetry.deleteMessage("1", 3);
			expect(fetch).toHaveBeenCalledTimes(3);

			// Cuarta llamada: el breaker está abierto, sendMessage/deleteMessage
			// capturan el error y devuelven sin volver a llamar fetch.
			const beforeCount = vi.mocked(fetch).mock.calls.length;
			await noRetry.deleteMessage("1", 4);
			expect(vi.mocked(fetch).mock.calls.length).toBe(beforeCount);
		});

		it("resets the failure counter when a successful response follows", async () => {
			const noRetry = new TelegramClient("test:token", {
				retries: 0,
				circuitBreakerThreshold: 3,
			});
			vi.mocked(fetch)
				.mockRejectedValueOnce(transientErr())
				.mockRejectedValueOnce(transientErr())
				.mockResolvedValueOnce(
					okResponse({ ok: true, result: { message_id: 1, chat: { id: 1 } } }),
				)
				.mockRejectedValueOnce(transientErr())
				.mockRejectedValueOnce(transientErr());

			await noRetry.deleteMessage("1", 1); // fails, count=1
			await noRetry.deleteMessage("1", 2); // fails, count=2
			await noRetry.deleteMessage("1", 3); // success -> resets to 0
			await noRetry.deleteMessage("1", 4); // fails, count=1
			await noRetry.deleteMessage("1", 5); // fails, count=2
			// Breaker sigue cerrado: ningún fetch fue interceptado por el breaker.
			expect(fetch).toHaveBeenCalledTimes(5);
		});

		it("transitions to half-open after cooldown elapses and a successful trial closes it", async () => {
			vi.useFakeTimers();
			const baseTime = new Date("2024-01-01T00:00:00Z").getTime();
			vi.setSystemTime(baseTime);

			const noRetry = new TelegramClient("test:token", {
				retries: 0,
				circuitBreakerThreshold: 2,
				circuitBreakerCooldownMs: 10_000,
			});
			vi.mocked(fetch)
				.mockRejectedValueOnce(transientErr())
				.mockRejectedValueOnce(transientErr())
				.mockResolvedValueOnce(
					okResponse({ ok: true, result: { message_id: 1, chat: { id: 1 } } }),
				)
				.mockResolvedValueOnce(
					okResponse({ ok: true, result: { message_id: 2, chat: { id: 1 } } }),
				);

			await noRetry.deleteMessage("1", 1);
			await noRetry.deleteMessage("1", 2);
			// Aún dentro del cooldown: no se invoca fetch.
			const beforeCooldownCalls = vi.mocked(fetch).mock.calls.length;
			await noRetry.deleteMessage("1", 99);
			expect(vi.mocked(fetch).mock.calls.length).toBe(beforeCooldownCalls);

			vi.setSystemTime(baseTime + 10_001);
			await noRetry.deleteMessage("1", 3); // half-open trial succeeds → closed
			await noRetry.deleteMessage("1", 4); // breaker cerrado, fetch se invoca
			expect(fetch).toHaveBeenCalledTimes(4);
			vi.useRealTimers();
		});

		it("in half-open, a failing trial re-opens the breaker", async () => {
			vi.useFakeTimers();
			const baseTime = new Date("2024-01-01T00:00:00Z").getTime();
			vi.setSystemTime(baseTime);

			const noRetry = new TelegramClient("test:token", {
				retries: 0,
				circuitBreakerThreshold: 2,
				circuitBreakerCooldownMs: 10_000,
			});
			vi.mocked(fetch)
				.mockRejectedValueOnce(transientErr())
				.mockRejectedValueOnce(transientErr())
				.mockRejectedValueOnce(transientErr()); // half-open trial que falla

			await noRetry.deleteMessage("1", 1);
			await noRetry.deleteMessage("1", 2); // count=2 → opens
			vi.setSystemTime(baseTime + 10_001);
			await noRetry.deleteMessage("1", 3); // half-open trial fails → re-opens

			// Inmediatamente después del trial fallido, debe estar abierto otra vez.
			const beforeRetryCalls = vi.mocked(fetch).mock.calls.length;
			vi.setSystemTime(baseTime + 10_002);
			await noRetry.deleteMessage("1", 4);
			expect(vi.mocked(fetch).mock.calls.length).toBe(beforeRetryCalls);
			vi.useRealTimers();
		});

		it("only one fetch happens when multiple calls arrive after cooldown (others fast-failed)", async () => {
			vi.useFakeTimers();
			const baseTime = new Date("2024-01-01T00:00:00Z").getTime();
			vi.setSystemTime(baseTime);

			const noRetry = new TelegramClient("test:token", {
				retries: 0,
				circuitBreakerThreshold: 2,
				circuitBreakerCooldownMs: 10_000,
			});
			let resolveTrial: ((v: Response) => void) | undefined;
			vi.mocked(fetch)
				.mockRejectedValueOnce(transientErr())
				.mockRejectedValueOnce(transientErr())
				.mockImplementationOnce(
					() => new Promise<Response>((resolve) => { resolveTrial = resolve; }),
				);

			await noRetry.deleteMessage("1", 1);
			await noRetry.deleteMessage("1", 2); // opens (threshold=2)

			vi.setSystemTime(baseTime + 10_001);
			// Disparamos la trial sin await; dejamos microtasks para que el
			// beforeAttempt corra y registre el fetch (state → half_open).
			const trialPromise = noRetry.deleteMessage("1", 100);
			await Promise.resolve();
			await Promise.resolve();
			// 3 fetches hasta ahora: 2 trips + 1 trial registrada.
			expect(vi.mocked(fetch).mock.calls.length).toBe(3);

			// Mientra la trial sigue "en vuelo", nuevas llamadas deben fast-fail
			// sin volver a llamar fetch (state = half_open).
			await noRetry.deleteMessage("1", 3);
			await noRetry.deleteMessage("1", 4);
			await noRetry.deleteMessage("1", 5);
			expect(vi.mocked(fetch).mock.calls.length).toBe(3);

			// Resolvemos la trial para cerrar la promesa sin dejar tests colgados.
			resolveTrial!(okResponse({ ok: true, result: { message_id: 1, chat: { id: 1 } } }));
			await trialPromise;

			vi.useRealTimers();
		});

		it("a 4xx response is treated as a success by the breaker (network is reachable)", async () => {
			const noRetry = new TelegramClient("test:token", {
				retries: 0,
				circuitBreakerThreshold: 2,
			});
			vi.mocked(fetch).mockResolvedValue(
				new Response(null, { status: 400 }),
			);
			// deleteMessage no tiene fallback de parse_mode, así que es 1 fetch por call.
			await noRetry.deleteMessage("1", 1);
			await noRetry.deleteMessage("1", 2);
			await noRetry.deleteMessage("1", 3);
			// 3 fetches, breaker cerrado (4xx cuenta como éxito de red).
			expect(fetch).toHaveBeenCalledTimes(3);
		});

		it("emits a warn log on each trip with the right fields", async () => {
			const warnSpy = vi.spyOn(
				(await import("../../src/infrastructure/logger.ts")).logger,
				"warn",
			);
			const noRetry = new TelegramClient("test:token", {
				retries: 0,
				circuitBreakerThreshold: 2,
				circuitBreakerCooldownMs: 30_000,
			});
			vi.mocked(fetch).mockRejectedValue(transientErr());

			await noRetry.deleteMessage("1", 1);
			await noRetry.deleteMessage("1", 2); // trips
			expect(warnSpy).toHaveBeenCalledWith(
				"tg circuit breaker opened",
				expect.objectContaining({
					failures: 2,
					previousState: "closed",
				}),
			);
			warnSpy.mockRestore();
		});

		it("CircuitBreakerOpenError thrown by beforeAttempt does not double-count as a failure", async () => {
			vi.useFakeTimers();
			const baseTime = new Date("2024-01-01T00:00:00Z").getTime();
			vi.setSystemTime(baseTime);

			const noRetry = new TelegramClient("test:token", {
				retries: 0,
				circuitBreakerThreshold: 2,
				circuitBreakerCooldownMs: 10_000,
			});
			vi.mocked(fetch)
				.mockRejectedValueOnce(transientErr())
				.mockRejectedValueOnce(transientErr())
				.mockResolvedValue(new Response(null, { status: 200 }));

			await noRetry.deleteMessage("1", 1);
			await noRetry.deleteMessage("1", 2); // trips (failures=2, state=open)

			// Llamadas adicionales mientras el breaker sigue abierto no deben
			// invocar fetch NI incrementar failures (que ya estaba en 2).
			const beforeCalls = vi.mocked(fetch).mock.calls.length;
			await noRetry.deleteMessage("1", 3);
			await noRetry.deleteMessage("1", 4);
			expect(vi.mocked(fetch).mock.calls.length).toBe(beforeCalls);

			vi.setSystemTime(baseTime + 10_001);
			// half-open trial succeeds; recordSuccess resetea failures → 0.
			await noRetry.deleteMessage("1", 5);
			// Siguiente llamada con breaker cerrado, fetch se invoca normalmente.
			await noRetry.deleteMessage("1", 6);
			expect(vi.mocked(fetch).mock.calls.length).toBe(beforeCalls + 2);
			vi.useRealTimers();
		});
	});
});

describe("TelegramClient.sendChatAction", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	it("llama a sendChatAction con chat_id y action", async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response(JSON.stringify({ ok: true }), { status: 200 }),
		);
		const client = new TelegramClient("tok", { retries: 0 });

		await client.sendChatAction("123", "typing");

		expect(fetch).toHaveBeenCalledWith(
			"https://api.telegram.org/bottok/sendChatAction",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ chat_id: "123", action: "typing" }),
			}),
		);
	});

	it("no lanza excepción si la llamada falla (fire-and-forget)", async () => {
		vi.mocked(fetch).mockRejectedValue(new Error("network error"));
		const client = new TelegramClient("tok", { retries: 0 });

		await expect(client.sendChatAction("123", "typing")).resolves.toBeUndefined();
	});
});

/**
 * Regresión del 30-sep-2026: con los reintentos por defecto, una prueba de
 * half-open que fallaba dejaba el breaker atascado en `half_open` PARA
 * SIEMPRE (el reintento veía la prueba "en vuelo" y lanzaba
 * CircuitBreakerOpenError, que no cuenta como fallo). Telegram quedó mudo
 * ocho horas hasta un reinicio manual.
 */
describe("TelegramClient — recuperación del circuit breaker", () => {
	const transientErr = () =>
		new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });

	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	it("una prueba fallida reabre el breaker en vez de dejarlo en half-open", async () => {
		const client = new TelegramClient("test:token", {
			retries: 1,
			circuitBreakerThreshold: 2,
			circuitBreakerCooldownMs: 50,
			circuitBreakerHalfOpenMs: 5_000,
		});
		vi.mocked(fetch).mockRejectedValue(transientErr());

		// retries: 1 → cada llamada agota 2 intentos y suma UN fallo.
		await client.deleteMessage("1", 1);
		await client.deleteMessage("1", 2);
		expect(client.breakerInfo().state).toBe("open");

		// Pasado el cooldown, la prueba también falla: debe volver a abrir.
		await new Promise((r) => setTimeout(r, 60));
		await client.deleteMessage("1", 3);
		expect(client.breakerInfo().state).toBe("open");
		expect(client.breakerInfo().probeInFlight).toBe(false);

		// Y no está atascado: tras otro cooldown vuelve a intentar la red.
		await new Promise((r) => setTimeout(r, 60));
		const antes = vi.mocked(fetch).mock.calls.length;
		await client.deleteMessage("1", 4);
		expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(antes);
	});

	it("una prueba colgada caduca y otra llamada puede relevarla", async () => {
		const client = new TelegramClient("test:token", {
			retries: 0,
			circuitBreakerThreshold: 1,
			circuitBreakerCooldownMs: 20,
			circuitBreakerHalfOpenMs: 30,
		});
		let resolverPrueba: ((value: Response) => void) | undefined;
		vi.mocked(fetch)
			.mockRejectedValueOnce(transientErr())
			.mockImplementationOnce(
				() =>
					new Promise<Response>((resolve) => {
						resolverPrueba = resolve;
					}),
			)
			.mockResolvedValueOnce(
				okResponse({ ok: true, result: { message_id: 9, chat: { id: 1 } } }),
			);

		await client.deleteMessage("1", 1); // threshold 1 → abre
		await new Promise((r) => setTimeout(r, 25));
		const colgada = client.deleteMessage("1", 2); // toma la prueba y no responde
		await new Promise((r) => setTimeout(r, 10));
		expect(client.breakerInfo().state).toBe("half_open");
		expect(client.breakerInfo().probeInFlight).toBe(true);

		// Pasada la caducidad, otra llamada releva la prueba y esta sí responde.
		await new Promise((r) => setTimeout(r, 40));
		await client.deleteMessage("1", 3);
		expect(client.breakerInfo().state).toBe("closed");

		// Limpieza: resolvemos la prueba vieja para no dejar promesas colgadas.
		resolverPrueba?.(okResponse({ ok: true, result: { message_id: 1, chat: { id: 1 } } }));
		await colgada;
	});

	it("probeHealth cierra el breaker cuando Telegram responde", async () => {
		const client = new TelegramClient("test:token", {
			retries: 0,
			circuitBreakerThreshold: 1,
			circuitBreakerCooldownMs: 10,
		});
		vi.mocked(fetch)
			.mockRejectedValueOnce(transientErr())
			.mockResolvedValueOnce(okResponse({ ok: true, result: { id: 1 } }));

		await client.deleteMessage("1", 1);
		expect(client.breakerInfo().state).toBe("open");

		await new Promise((r) => setTimeout(r, 15));
		const probe = await client.probeHealth();
		expect(probe.ok).toBe(true);
		expect(client.breakerInfo().state).toBe("closed");
	});
});
