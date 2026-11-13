import {
	GatewayUnavailableError,
	GatewayUnexpectedResponseError,
	TelegramRejectedError,
} from "../domain/gateway-errors.ts";
import type {
	DeleteMessageInput,
	EditButtonsInput,
	SendAlbumInput,
	SendMediaInput,
	SendResult,
	SendTextInput,
	TgGatewayPort,
	TgHealth,
} from "../domain/tg-gateway-port.ts";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type GatewayTimeout = "text" | "media" | "album" | "markup" | "health";

export interface TgGatewayClientOptions {
	/** Inyectable para tests; por defecto, el fetch global. */
	fetchImpl?: FetchLike;
	timeouts?: Partial<Record<GatewayTimeout, number>>;
}

// Mismos márgenes que los timeouts del gateway: los multipart viajan enteros y
// merecen más margen que una llamada JSON.
const DEFAULT_TIMEOUTS: Record<GatewayTimeout, number> = {
	text: 15_000,
	media: 60_000,
	album: 90_000,
	markup: 15_000,
	health: 10_000,
};

function requireSendResult(data: unknown): SendResult {
	const record = data as {
		ok?: unknown;
		result?: { messageId?: unknown };
	} | null;
	const messageId = record?.result?.messageId;
	if (
		record?.ok !== true ||
		typeof messageId !== "number" ||
		!Number.isInteger(messageId) ||
		messageId <= 0
	) {
		throw new GatewayUnexpectedResponseError();
	}
	return { messageId };
}

function requireOk(data: unknown): void {
	const record = data as { ok?: unknown } | null;
	if (record?.ok !== true) throw new GatewayUnexpectedResponseError();
}

function readHealth(data: unknown): TgHealth {
	const record = data as {
		ok?: unknown;
		alive?: unknown;
		uptime?: unknown;
		breaker?: { state?: unknown; failures?: unknown };
	} | null;
	const ok = record?.ok;
	if (typeof ok !== "boolean") throw new GatewayUnexpectedResponseError();
	const state = record?.breaker?.state;
	const failures = record?.breaker?.failures;
	return {
		ok,
		alive: record?.alive === true,
		uptimeSeconds: typeof record?.uptime === "number" ? record.uptime : 0,
		...(typeof state === "string"
			? {
					breaker: {
						state,
						failures: typeof failures === "number" ? failures : 0,
					},
				}
			: {}),
	};
}

/**
 * Cliente HTTP de tg-gateway. No propaga el cuerpo de error del gateway: puede
 * llevar detalles internos y la regla es no devolver ni registrar el chat_id.
 */
export class TgGatewayClient implements TgGatewayPort {
	private readonly baseUrl: string;
	private readonly fetchImpl: FetchLike;
	private readonly timeouts: Record<GatewayTimeout, number>;

	constructor(baseUrl: string, options: TgGatewayClientOptions = {}) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
		this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
	}

	async health(): Promise<TgHealth> {
		const data = await this.request(
			"/health",
			{ method: "GET" },
			this.timeouts.health,
		);
		return readHealth(data);
	}

	async sendText(input: SendTextInput): Promise<SendResult> {
		const data = await this.post(
			"/api/send",
			{
				chat_id: input.chatId,
				text: input.text,
				parse_mode: input.parseMode,
			},
			this.timeouts.text,
		);
		return requireSendResult(data);
	}

	async sendPhoto(input: SendMediaInput): Promise<SendResult> {
		const data = await this.post(
			"/api/send-photo",
			{
				chat_id: input.chatId,
				file_path: input.filePath,
				...(input.caption ? { caption: input.caption } : {}),
			},
			this.timeouts.media,
		);
		return requireSendResult(data);
	}

	async sendVideo(input: SendMediaInput): Promise<SendResult> {
		const data = await this.post(
			"/api/send-video",
			{
				chat_id: input.chatId,
				file_path: input.filePath,
				...(input.caption ? { caption: input.caption } : {}),
			},
			this.timeouts.media,
		);
		return requireSendResult(data);
	}

	async sendAlbum(input: SendAlbumInput): Promise<SendResult> {
		const data = await this.post(
			"/api/send-media-group",
			{
				chat_id: input.chatId,
				file_paths: input.filePaths,
				...(input.caption ? { caption: input.caption } : {}),
			},
			this.timeouts.album,
		);
		return requireSendResult(data);
	}

	async editButtons(input: EditButtonsInput): Promise<void> {
		const data = await this.post(
			"/api/edit-reply-markup",
			{
				chat_id: input.chatId,
				message_id: input.messageId,
				reply_markup: input.replyMarkup,
			},
			this.timeouts.markup,
		);
		requireOk(data);
	}

	async deleteMessage(input: DeleteMessageInput): Promise<void> {
		const data = await this.post(
			"/api/delete-message",
			{ chat_id: input.chatId, message_id: input.messageId },
			this.timeouts.markup,
		);
		requireOk(data);
	}

	private post(
		path: string,
		body: Record<string, unknown>,
		timeoutMs: number,
	): Promise<unknown> {
		return this.request(
			path,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			},
			timeoutMs,
		);
	}

	private async request(
		path: string,
		init: RequestInit,
		timeoutMs: number,
	): Promise<unknown> {
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.baseUrl}${path}`, {
				...init,
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch {
			throw new GatewayUnavailableError();
		}
		if (response.status === 502) throw new TelegramRejectedError();
		if (response.status >= 500) throw new GatewayUnavailableError();
		if (!response.ok) {
			throw new GatewayUnexpectedResponseError(response.status);
		}
		try {
			return await response.json();
		} catch {
			throw new GatewayUnexpectedResponseError(response.status);
		}
	}
}
