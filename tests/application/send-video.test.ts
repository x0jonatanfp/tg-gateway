import { describe, it, expect, vi } from "vitest";
import { SendVideoUseCase } from "../../src/application/send-video.ts";
import { createMockTelegramPort, createQueueService, makeVideo } from "../test/helpers.ts";

describe("SendVideoUseCase", () => {
	it("sends video via telegram port through queue", async () => {
		const telegram = createMockTelegramPort();
		const queue = createQueueService();
		const useCase = new SendVideoUseCase(telegram, queue);

		const video = makeVideo();
		await useCase.execute(video);

		expect(telegram.sendVideo).toHaveBeenCalledWith(video);
	});

	it("returns the result from telegram", async () => {
		const telegram = createMockTelegramPort();
		vi.mocked(telegram.sendVideo).mockResolvedValue({
			chatId: 1,
			messageId: 99,
		});
		const useCase = new SendVideoUseCase(telegram, createQueueService());

		const result = await useCase.execute(makeVideo());

		expect(result).toEqual({ chatId: 1, messageId: 99 });
	});
});
