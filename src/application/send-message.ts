import type { OutgoingMessage } from "../domain/entities/message.ts";
import type { TelegramPort } from "../domain/ports/telegram.ts";
import type { QueueService } from "../domain/services/queue.ts";

export class SendMessageUseCase {
	constructor(
		private telegram: TelegramPort,
		private queue: QueueService,
	) {}

	async execute(msg: OutgoingMessage) {
		return this.queue.enqueue(() => this.telegram.sendMessage(msg));
	}
}
