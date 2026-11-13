import type { OutgoingMediaGroup } from "../domain/entities/message.ts";
import type { TelegramPort } from "../domain/ports/telegram.ts";
import type { QueueService } from "../domain/services/queue.ts";

export class SendMediaGroupUseCase {
	constructor(
		private telegram: TelegramPort,
		private queue: QueueService,
	) {}

	async execute(group: OutgoingMediaGroup) {
		return this.queue.enqueue(() => this.telegram.sendMediaGroup(group));
	}
}
