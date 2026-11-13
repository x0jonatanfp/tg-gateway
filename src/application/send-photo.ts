import type { OutgoingPhoto } from "../domain/entities/message.ts";
import type { TelegramPort } from "../domain/ports/telegram.ts";
import type { QueueService } from "../domain/services/queue.ts";

export class SendPhotoUseCase {
	constructor(
		private telegram: TelegramPort,
		private queue: QueueService,
	) {}

	async execute(photo: OutgoingPhoto) {
		return this.queue.enqueue(() => this.telegram.sendPhoto(photo, photo.caption));
	}
}
