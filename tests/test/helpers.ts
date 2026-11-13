import { vi } from "vitest";
import type { TelegramPort } from "../../src/domain/ports/telegram.ts";
import type { HandlerRegistryPort } from "../../src/domain/ports/handlers.ts";
import type {
	OutgoingMediaGroup,
	OutgoingMessage,
	OutgoingPhoto,
	OutgoingVideo,
	SendResult,
	TelegramOperationResult,
} from "../../src/domain/entities/message.ts";
import { QueueService } from "../../src/domain/services/queue.ts";

export function createMockTelegramPort(): TelegramPort {
	return {
		sendMessage:
			vi.fn<(msg: OutgoingMessage) => Promise<SendResult | null>>(),
		sendPhoto:
			vi.fn<
				(photo: OutgoingPhoto, caption?: string) => Promise<SendResult | null>
			>(),
		sendVideo: vi.fn<(video: OutgoingVideo) => Promise<SendResult | null>>(),
		sendMediaGroup: vi.fn<
			(group: OutgoingMediaGroup) => Promise<SendResult | null>
		>(),
		editReplyMarkup: vi
			.fn<
				(
					chatId: string,
					messageId: number,
					replyMarkup: Record<string, unknown>,
				) => Promise<TelegramOperationResult>
			>()
			.mockResolvedValue({ ok: true }),
		deleteMessage: vi
			.fn<
				(chatId: string, messageId: number) => Promise<TelegramOperationResult>
			>()
			.mockResolvedValue({ ok: true }),
		answerCallbackQuery:
			vi.fn<(callbackId: string, text?: string) => Promise<void>>(),
	};
}

export function createMockHandlerRegistry(): HandlerRegistryPort {
	const handlers = new Map<string, string>();

	return {
		register: vi.fn((command: string, webhook: string) => {
			handlers.set(command, webhook);
		}),
		unregister: vi.fn((command: string) => {
			handlers.delete(command);
		}),
		getHandler: vi.fn((command: string) => handlers.get(command)),
		list: vi.fn(() =>
			Array.from(handlers.entries()).map(([command, webhook]) => ({
				command,
				webhook,
			})),
		),
	};
}

export function createQueueService(minIntervalMs = 0): QueueService {
	return new QueueService(minIntervalMs);
}

export function makeMessage(
	overrides?: Partial<OutgoingMessage>,
): OutgoingMessage {
	return { chatId: "12345", text: "hello", ...overrides };
}

export function makePhoto(overrides?: Partial<OutgoingPhoto>): OutgoingPhoto {
	return { chatId: "12345", filePath: "/tmp/photo.jpg", ...overrides };
}

export function makeVideo(overrides?: Partial<OutgoingVideo>): OutgoingVideo {
	return { chatId: "12345", filePath: "/tmp/video.mp4", ...overrides };
}

export function makeMediaGroup(
	overrides?: Partial<OutgoingMediaGroup>,
): OutgoingMediaGroup {
	return {
		chatId: "12345",
		filePaths: ["/tmp/a.jpg", "/tmp/b.jpg"],
		...overrides,
	};
}
