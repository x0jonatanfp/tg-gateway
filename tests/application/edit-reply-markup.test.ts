import { describe, it, expect } from "vitest";
import { EditReplyMarkupUseCase } from "../../src/application/edit-reply-markup.ts";
import { createMockTelegramPort, createQueueService } from "../test/helpers.ts";

describe("EditReplyMarkupUseCase", () => {
	it("edits reply markup via telegram port through queue", async () => {
		const telegram = createMockTelegramPort();
		const queue = createQueueService();
		const useCase = new EditReplyMarkupUseCase(telegram, queue);

		const markup = { inline_keyboard: [[{ text: "click", callback_data: "x" }]] };
		await useCase.execute("123", 42, markup);

		expect(telegram.editReplyMarkup).toHaveBeenCalledWith("123", 42, markup);
	});
});
