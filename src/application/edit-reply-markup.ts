import type { TelegramPort } from "../domain/ports/telegram.ts";
import type { QueueService } from "../domain/services/queue.ts";

export class EditReplyMarkupUseCase {
	constructor(
		private telegram: TelegramPort,
		private queue: QueueService,
	) {}

	async execute(
		chatId: string,
		messageId: number,
		replyMarkup: Record<string, unknown>,
	) {
		return this.queue.enqueue(() =>
			this.telegram.editReplyMarkup(chatId, messageId, replyMarkup),
		);
	}
}
