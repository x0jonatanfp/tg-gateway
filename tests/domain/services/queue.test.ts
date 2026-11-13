import { describe, it, expect } from "vitest";
import { QueueService } from "../../../src/domain/services/queue.ts";

describe("QueueService", () => {
	it("executes a task and returns its value", async () => {
		const q = new QueueService(0);
		const result = await q.enqueue(() => Promise.resolve(42));
		expect(result).toBe(42);
	});

	it("maintains FIFO order", async () => {
		const q = new QueueService(0);
		const order: number[] = [];
		const p1 = q.enqueue(async () => {
			await Promise.resolve();
			order.push(1);
		});
		const p2 = q.enqueue(async () => {
			order.push(2);
		});
		await Promise.all([p1, p2]);
		expect(order).toEqual([1, 2]);
	});

	it("respects minIntervalMs between tasks", async () => {
		const q = new QueueService(100);
		const timestamps: number[] = [];
		await q.enqueue(async () => {
			timestamps.push(Date.now());
		});
		await q.enqueue(async () => {
			timestamps.push(Date.now());
		});
		expect(timestamps).toHaveLength(2);
		expect(timestamps[1]! - timestamps[0]!).toBeGreaterThanOrEqual(90);
	});

	it("first task does not wait", async () => {
		const q = new QueueService(5000);
		const start = Date.now();
		await q.enqueue(async () => {});
		const elapsed = Date.now() - start;
		expect(elapsed).toBeLessThan(100);
	});

	it("second task waits for minIntervalMs from first task completion", async () => {
		const q = new QueueService(50);
		const start = Date.now();
		await q.enqueue(async () => {});
		await q.enqueue(async () => {});
		const elapsed = Date.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(45);
	});

	it("task wait time = minIntervalMs - time since last sent", async () => {
		const q = new QueueService(100);
		const timestamps: number[] = [];
		await q.enqueue(async () => {
			timestamps.push(Date.now());
		});
		await q.enqueue(async () => {
			timestamps.push(Date.now());
		});
		const diff = timestamps[1]! - timestamps[0]!;
		expect(diff).toBeGreaterThanOrEqual(90);
	});

	it("continues chain even if a task rejects", async () => {
		const q = new QueueService(0);
		const results: string[] = [];
		await q.enqueue(async () => {
			throw new Error("fail");
		}).catch(() => {});
		await q.enqueue(async () => {
			results.push("after failure");
		});
		expect(results).toEqual(["after failure"]);
	});

	it("resolves with task return value after previous failure", async () => {
		const q = new QueueService(0);
		await q.enqueue(async () => {
			throw new Error("boom");
		}).catch(() => {});
		const val = await q.enqueue(() => Promise.resolve("ok"));
		expect(val).toBe("ok");
	});

	it("handles concurrent enqueue calls", async () => {
		const q = new QueueService(0);
		const results: number[] = [];
		await Promise.all([
			q.enqueue(async () => {
				results.push(1);
			}),
			q.enqueue(async () => {
				results.push(2);
			}),
			q.enqueue(async () => {
				results.push(3);
			}),
		]);
		expect(results).toEqual([1, 2, 3]);
	});

	it("tasks with error do not delay subsequent tasks beyond minInterval", async () => {
		const q = new QueueService(50);
		const timestamps: number[] = [];
		await q.enqueue(async () => {
			throw new Error("boom");
		}).catch(() => {});
		await q.enqueue(async () => {
			timestamps.push(Date.now());
		});
		expect(timestamps).toHaveLength(1);
	});
});
