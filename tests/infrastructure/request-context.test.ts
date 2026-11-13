import { describe, it, expect } from "vitest";
import { QueueService } from "../../src/domain/services/queue.ts";
import {
	currentRequestId,
	runWithRequestId,
} from "../../src/infrastructure/request-context.ts";

describe("request context", () => {
	it("propagates the request id through await", async () => {
		await runWithRequestId("req-await", async () => {
			await Promise.resolve();
			expect(currentRequestId()).toBe("req-await");
		});
		expect(currentRequestId()).toBeUndefined();
	});

	it("propagates the request id through QueueService.enqueue", async () => {
		const queue = new QueueService(0);
		await runWithRequestId("req-queue", async () => {
			await expect(
				queue.enqueue(async () => currentRequestId()),
			).resolves.toBe("req-queue");
		});
	});
});
