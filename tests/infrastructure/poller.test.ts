import {
	describe,
	it,
	expect,
	vi,
	beforeEach,
	afterEach,
	type Mock,
} from "vitest";
import { Poller } from "../../src/infrastructure/poller.ts";
import type { IncomingUpdate } from "../../src/domain/entities/message.ts";
import { logger } from "../../src/infrastructure/logger.ts";

type UpdateHandler = (update: IncomingUpdate) => Promise<void>;

function makeResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function tick(): Promise<void> {
	return new Promise((r) => setTimeout(r, 0));
}

describe("Poller", () => {
	let poller: Poller;
	let onUpdate: Mock<UpdateHandler>;

	beforeEach(() => {
		onUpdate = vi.fn<UpdateHandler>().mockResolvedValue(undefined);
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		poller?.stop();
		vi.useRealTimers();
	});

	it("fetches initial offset on start", async () => {
		vi.mocked(fetch).mockResolvedValue(
			makeResponse({
				ok: true,
				result: [{ update_id: 5 }],
			}),
		);

		poller = new Poller(
			{ token: "test:token", timeout: 30 },
			onUpdate,
		);

		poller.start();
		await tick();
		poller.stop();

		expect(fetch).toHaveBeenCalledWith(
			expect.stringContaining("getUpdates?offset=0&limit=1"),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it("sets offset based on last update_id from initial fetch", async () => {
		vi.mocked(fetch).mockResolvedValue(
			makeResponse({
				ok: true,
				result: [{ update_id: 10 }, { update_id: 11 }],
			}),
		);

		poller = new Poller({ token: "test:token", timeout: 30 }, onUpdate);
		poller.start();
		await tick();
		poller.stop();

		const firstPollUrl = vi.mocked(fetch).mock.calls[1]?.[0] as string;
		expect(firstPollUrl).toContain("offset=12");
	});

	it("calls onUpdate for each update in poll response", async () => {
		vi.mocked(fetch)
			.mockResolvedValueOnce(makeResponse({ ok: true, result: [] }))
			.mockResolvedValueOnce(
				makeResponse({
					ok: true,
					result: [
						{ update_id: 100, message: { text: "a" } },
						{ update_id: 101, message: { text: "b" } },
					],
				}),
			);

		poller = new Poller({ token: "test:token", timeout: 30 }, onUpdate);
		poller.start();
		await tick();
		await tick();
		poller.stop();

		expect(onUpdate).toHaveBeenCalledTimes(2);
	});

	it("error in onUpdate does not crash poller", async () => {
		const errHandler = vi
			.fn<UpdateHandler>()
			.mockRejectedValue(new Error("handler crash"));

		vi.mocked(fetch)
			.mockResolvedValueOnce(makeResponse({ ok: true, result: [] }))
			.mockResolvedValueOnce(
				makeResponse({
					ok: true,
					result: [{ update_id: 200 }],
				}),
			);

		poller = new Poller({ token: "test:token", timeout: 30 }, errHandler);
		poller.start();
		await tick();
		await tick();
		poller.stop();

		expect(errHandler).toHaveBeenCalledTimes(1);
	});

	it("does not throw on initial offset fetch failure", async () => {
		vi.mocked(fetch).mockRejectedValueOnce(new Error("initial fail"));

		poller = new Poller({ token: "test:token", timeout: 30 }, onUpdate);
		poller.start();
		await tick();
		poller.stop();

		// Sobrevive al fallo del fetch inicial y entra al loop de polling: la
		// primera llamada es el offset inicial (que falla), la segunda ya es el
		// primer getUpdates del bucle.
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("passes an AbortSignal to the initial offset fetch", async () => {
		vi.mocked(fetch).mockResolvedValue(
			makeResponse({ ok: true, result: [] }),
		);

		poller = new Poller({ token: "test:token", timeout: 30 }, onUpdate);
		poller.start();
		await tick();
		poller.stop();

		const init = vi.mocked(fetch).mock.calls[0]?.[1];
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});

	it("agrupa fallos consecutivos y registra la recuperación", async () => {
		vi.useFakeTimers();
		const warnSpy = vi.spyOn(logger, "warn");
		const debugSpy = vi.spyOn(logger, "debug");
		const infoSpy = vi.spyOn(logger, "info");
		infoSpy.mockImplementation((message: string) => {
			if (message === "poll recovered") poller.stop();
		});
		vi.mocked(fetch)
			.mockResolvedValueOnce(makeResponse({ ok: true, result: [] }))
			.mockRejectedValueOnce(new Error("first"))
			.mockRejectedValueOnce(new Error("second"))
			.mockResolvedValueOnce(makeResponse({ ok: true, result: [] }));

		poller = new Poller({ token: "test:token", timeout: 30 }, onUpdate);
		const promise = poller.start();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(2_000);
		await vi.advanceTimersByTimeAsync(4_000);
		poller.stop();
		await promise;

		expect(warnSpy).toHaveBeenCalledWith(
			"poll error, retrying",
			expect.objectContaining({ error: "first" }),
		);
		expect(debugSpy).toHaveBeenCalledWith(
			"poll error, retrying",
			expect.objectContaining({ error: "second" }),
		);
		expect(infoSpy).toHaveBeenCalledWith("poll recovered", { failures: 2 });
	});

	it("no trata un timeout de long-poll como fallo", async () => {
		vi.useFakeTimers();
		const warnSpy = vi.spyOn(logger, "warn");
		const infoSpy = vi.spyOn(logger, "info");
		// `AbortSignal.timeout` rechaza con un DOMException cuyo name es este.
		const timeout = Object.assign(new Error("timeout"), {
			name: "TimeoutError",
		});
		vi.mocked(fetch)
			.mockResolvedValueOnce(makeResponse({ ok: true, result: [] }))
			.mockRejectedValueOnce(timeout);

		poller = new Poller({ token: "test:token", timeout: 30 }, onUpdate);
		const promise = poller.start();
		await vi.advanceTimersByTimeAsync(0);
		poller.stop();
		await vi.advanceTimersByTimeAsync(2_000);
		await promise;

		expect(warnSpy).not.toHaveBeenCalledWith(
			"poll error, retrying",
			expect.anything(),
		);
		expect(infoSpy).not.toHaveBeenCalledWith(
			"poll recovered",
			expect.anything(),
		);
	});
});
