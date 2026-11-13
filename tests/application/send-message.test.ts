import { describe, it, expect, vi } from "vitest";
import { SendMessageUseCase } from "../../src/application/send-message.ts";
import { createMockTelegramPort, createQueueService, makeMessage } from "../test/helpers.ts";

describe("SendMessageUseCase", () => {
	it("sends message via telegram port through queue", async () => {
		const telegram = createMockTelegramPort();
		const queue = createQueueService();
		const useCase = new SendMessageUseCase(telegram, queue);

		const msg = makeMessage();
		await useCase.execute(msg);

		expect(telegram.sendMessage).toHaveBeenCalledWith(msg);
	});

	it("returns the result from telegram", async () => {
		const telegram = createMockTelegramPort();
		vi.mocked(telegram.sendMessage).mockResolvedValue({
			chatId: 1,
			messageId: 99,
		});
		const useCase = new SendMessageUseCase(telegram, createQueueService());

		const result = await useCase.execute(makeMessage());

		expect(result).toEqual({ chatId: 1, messageId: 99 });
	});
});
