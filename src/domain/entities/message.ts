export interface OutgoingMessage {
	chatId: string;
	text?: string;
	parseMode?: "Markdown" | "HTML";
	replyMarkup?: Record<string, unknown>;
}

export interface OutgoingPhoto {
	chatId: string;
	filePath: string;
	caption?: string;
	replyMarkup?: Record<string, unknown>;
}

export interface OutgoingVideo {
	chatId: string;
	filePath: string;
	caption?: string;
	replyMarkup?: Record<string, unknown>;
}

/**
 * Álbum (media group) de 2-10 fotos que viaja como un solo mensaje. El pie
 * (caption) va en la primera y Telegram lo admite hasta 1024 caracteres.
 */
export interface OutgoingMediaGroup {
	chatId: string;
	filePaths: string[];
	caption?: string;
}

// Telegram usa snake_case en los updates entrantes
export interface IncomingUpdate {
	update_id: number;
	message?: {
		message_id: number;
		text?: string;
		caption?: string;
		chat: { id: number; type: string };
		from?: { id: number; username?: string };
		// Adjuntos de Telegram: solo se comprueba su presencia para decidir si
		// el update se reenvía al handler por defecto.
		voice?: unknown;
		audio?: unknown;
		photo?: unknown;
		document?: unknown;
		video?: unknown;
		sticker?: unknown;
	};
	callback_query?: {
		id: string;
		data?: string;
		from: { id: number; username?: string };
		message?: { message_id: number; chat: { id: number } };
	};
}

export interface SendResult {
	chatId: number;
	messageId: number;
}

/**
 * Resultado de las operaciones que no devuelven un mensaje (editar botones,
 * borrar). Antes el cliente se tragaba el error y la API contestaba `{ok:true}`
 * pasara lo que pasara; ahora `ok:false` viaja con la descripción de Telegram.
 */
export type TelegramOperationResult =
	| { ok: true }
	| { ok: false; error: string };
