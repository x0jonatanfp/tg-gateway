import { describe, it, expect, vi, beforeEach } from "vitest";
import { forwardUpdate } from "../../src/infrastructure/forwarder.ts";
import { logger } from "../../src/infrastructure/logger.ts";
import type { IncomingUpdate } from "../../src/domain/entities/message.ts";

function makeUpdate(overrides: Partial<IncomingUpdate> = {}): IncomingUpdate {
	return {
		update_id: 1,
		message: {
			message_id: 1,
			text: "/start",
			chat: { id: 100, type: "private" },
			from: { id: 200 },
		},
		...overrides,
	};
}

function transientErr() {
	return new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
}

describe("forwardUpdate", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
		);
	});

	it("POSTs the update to the webhook URL", async () => {
		const update = makeUpdate();
		await forwardUpdate("https://hook.example.com/start", update);

		expect(fetch).toHaveBeenCalledWith(
			"https://hook.example.com/start",
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(update),
			}),
		);
	});

	it("includes an AbortSignal with configurable timeout", async () => {
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
		await forwardUpdate("https://hook.example.com/start", makeUpdate(), {
			timeoutMs: 5432,
		});

		expect(timeoutSpy).toHaveBeenCalledWith(5432);
		timeoutSpy.mockRestore();
	});

	it("defaults to 10s timeout when none is specified", async () => {
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
		await forwardUpdate("https://hook.example.com/start", makeUpdate());

		expect(timeoutSpy).toHaveBeenCalledWith(10_000);
		timeoutSpy.mockRestore();
	});

	it("does not throw when fetch throws a non-transient error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new Error("plain non-network")),
		);

		await expect(
			forwardUpdate("https://hook.example.com/start", makeUpdate()),
		).resolves.toBeUndefined();
	});

	it("redacts webhook credentials in failure logs", async () => {
		const warnSpy = vi.spyOn(logger, "warn");
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
		);

		await forwardUpdate(
			"http://service-a:pass@localhost:14001/tg-update",
			makeUpdate(),
		);

		expect(warnSpy).toHaveBeenCalledWith(
			"forward failed",
			expect.objectContaining({
				webhook: "http://***:***@localhost:14001/tg-update",
			}),
		);
		expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("service-a:pass@");
	});

	it("does not throw when fetch returns a non-ok status", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
		);

		await expect(
			forwardUpdate("https://hook.example.com/start", makeUpdate()),
		).resolves.toBeUndefined();
	});

	describe("retries", () => {
		it("makes a single attempt when retries=0 (default)", async () => {
			vi.stubGlobal("fetch", vi.fn().mockRejectedValue(transientErr()));

			await forwardUpdate("https://hook.example.com/start", makeUpdate());

			expect(fetch).toHaveBeenCalledTimes(1);
		});

		it("retries transient errors until success", async () => {
			vi.stubGlobal(
				"fetch",
				vi
					.fn()
					.mockRejectedValueOnce(transientErr())
					.mockRejectedValueOnce(transientErr())
					.mockResolvedValueOnce(new Response(null, { status: 200 })),
			);

			await forwardUpdate("https://hook.example.com/start", makeUpdate(), {
				retries: 3,
			});

			expect(fetch).toHaveBeenCalledTimes(3);
		});

		it("stops after the configured number of retries", async () => {
			vi.stubGlobal("fetch", vi.fn().mockRejectedValue(transientErr()));

			await forwardUpdate("https://hook.example.com/start", makeUpdate(), {
				retries: 2,
			});

			expect(fetch).toHaveBeenCalledTimes(3); // 1 + 2 retries
		});

		it("does not retry non-transient errors", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockRejectedValue(new Error("plain non-network")),
			);

			await forwardUpdate("https://hook.example.com/start", makeUpdate(), {
				retries: 3,
			});

			expect(fetch).toHaveBeenCalledTimes(1);
		});

		it("does not retry 4xx/5xx responses (idempotency)", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
			);

			await forwardUpdate("https://hook.example.com/start", makeUpdate(), {
				retries: 3,
			});

			expect(fetch).toHaveBeenCalledTimes(1);
		});
	});
});
