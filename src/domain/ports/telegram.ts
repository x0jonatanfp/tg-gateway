import type {
	OutgoingMediaGroup,
	OutgoingMessage,
	OutgoingPhoto,
	OutgoingVideo,
	SendResult,
	TelegramOperationResult,
} from "../entities/message.ts";

export interface TelegramPort {
	sendMessage(msg: OutgoingMessage): Promise<SendResult | null>;
	sendPhoto(photo: OutgoingPhoto, caption?: string): Promise<SendResult | null>;
	sendVideo(video: OutgoingVideo): Promise<SendResult | null>;
	sendMediaGroup(group: OutgoingMediaGroup): Promise<SendResult | null>;
	editReplyMarkup(
		chatId: string,
		messageId: number,
		replyMarkup: Record<string, unknown>,
	): Promise<TelegramOperationResult>;
	deleteMessage(
		chatId: string,
		messageId: number,
	): Promise<TelegramOperationResult>;
	answerCallbackQuery(callbackId: string, text?: string): Promise<void>;
	sendChatAction(chatId: string, action: string): Promise<void>;
}
