import { describe, it, expect, vi } from "vitest";
import { SendPhotoUseCase } from "../../src/application/send-photo.ts";
import { createMockTelegramPort, createQueueService, makePhoto } from "../test/helpers.ts";

describe("SendPhotoUseCase", () => {
	it("sends photo via telegram port through queue", async () => {
		const telegram = createMockTelegramPort();
		const queue = createQueueService();
		const useCase = new SendPhotoUseCase(telegram, queue);

		const photo = makePhoto({ caption: "nice pic" });
		await useCase.execute(photo);

		expect(telegram.sendPhoto).toHaveBeenCalledWith(photo, "nice pic");
	});

	it("passes undefined caption when not provided", async () => {
		const telegram = createMockTelegramPort();
		const useCase = new SendPhotoUseCase(telegram, createQueueService());

		await useCase.execute(makePhoto({ caption: undefined }));

		expect(telegram.sendPhoto).toHaveBeenCalledWith(
			expect.objectContaining({ caption: undefined }),
			undefined,
		);
	});

	it("returns the result from telegram", async () => {
		const telegram = createMockTelegramPort();
		vi.mocked(telegram.sendPhoto).mockResolvedValue({
			chatId: 1,
			messageId: 99,
		});
		const useCase = new SendPhotoUseCase(telegram, createQueueService());

		const result = await useCase.execute(makePhoto());

		expect(result).toEqual({ chatId: 1, messageId: 99 });
	});
});
