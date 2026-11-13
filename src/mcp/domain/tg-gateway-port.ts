export interface SendResult {
	messageId: number;
}

export interface TgHealth {
	/** Veredicto del gateway: Telegram responde y el breaker está sano. */
	ok: boolean;
	/** El proceso del gateway está vivo (aunque Telegram no responda). */
	alive: boolean;
	uptimeSeconds: number;
	breaker?: { state: string; failures: number };
}

export interface SendTextInput {
	chatId: string;
	text: string;
	parseMode: "HTML" | "Markdown";
}

export interface SendMediaInput {
	chatId: string;
	filePath: string;
	caption?: string;
}

export interface SendAlbumInput {
	chatId: string;
	filePaths: string[];
	caption?: string;
}

export interface EditButtonsInput {
	chatId: string;
	messageId: number;
	replyMarkup: Record<string, unknown>;
}

export interface DeleteMessageInput {
	chatId: string;
	messageId: number;
}

/**
 * Cliente fino de la API HTTP de tg-gateway. El gateway sigue siendo el
 * servicio: aquí no hay token, ni polling, ni lógica de Telegram.
 */
export interface TgGatewayPort {
	health(): Promise<TgHealth>;
	sendText(input: SendTextInput): Promise<SendResult>;
	sendPhoto(input: SendMediaInput): Promise<SendResult>;
	sendVideo(input: SendMediaInput): Promise<SendResult>;
	sendAlbum(input: SendAlbumInput): Promise<SendResult>;
	editButtons(input: EditButtonsInput): Promise<void>;
	deleteMessage(input: DeleteMessageInput): Promise<void>;
}
