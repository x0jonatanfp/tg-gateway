import { describe, it, expect, vi } from "vitest";
import { SendMediaGroupUseCase } from "../../src/application/send-media-group.ts";
import {
	createMockTelegramPort,
	createQueueService,
	makeMediaGroup,
} from "../test/helpers.ts";

describe("SendMediaGroupUseCase", () => {
	it("sends media group via telegram port through queue", async () => {
		const telegram = createMockTelegramPort();
		const queue = createQueueService();
		const useCase = new SendMediaGroupUseCase(telegram, queue);

		const group = makeMediaGroup({ caption: "the post" });
		await useCase.execute(group);

		expect(telegram.sendMediaGroup).toHaveBeenCalledWith(group);
	});

	it("returns the result from telegram", async () => {
		const telegram = createMockTelegramPort();
		vi.mocked(telegram.sendMediaGroup).mockResolvedValue({
			chatId: 1,
			messageId: 7,
		});
		const useCase = new SendMediaGroupUseCase(telegram, createQueueService());

		const result = await useCase.execute(makeMediaGroup());

		expect(result).toEqual({ chatId: 1, messageId: 7 });
	});
});
