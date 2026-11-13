import type { OutgoingVideo } from "../domain/entities/message.ts";
import type { TelegramPort } from "../domain/ports/telegram.ts";
import type { QueueService } from "../domain/services/queue.ts";

export class SendVideoUseCase {
	constructor(
		private telegram: TelegramPort,
		private queue: QueueService,
	) {}

	async execute(video: OutgoingVideo) {
		return this.queue.enqueue(() => this.telegram.sendVideo(video));
	}
}
