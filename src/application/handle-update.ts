import type { IncomingUpdate } from "../domain/entities/message.ts";
import type { HandlerRegistryPort } from "../domain/ports/handlers.ts";
import { forwardUpdate } from "../infrastructure/forwarder.ts";
import { logger } from "../infrastructure/logger.ts";
import { truncateLogText } from "../infrastructure/log-text.ts";

const DEFAULT_HANDLER = "__default__";

export interface HandleUpdateOptions {
	forwardTimeoutMs?: number;
	forwardRetries?: number;
}

const DEFAULT_FORWARD_TIMEOUT_MS = 10_000;
const DEFAULT_FORWARD_RETRIES = 0;

export class HandleUpdateUseCase {
	private readonly forwardTimeoutMs: number;
	private readonly forwardRetries: number;

	constructor(
		private handlerRegistry: HandlerRegistryPort,
		options: HandleUpdateOptions = {},
	) {
		this.forwardTimeoutMs =
			options.forwardTimeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS;
		this.forwardRetries =
			options.forwardRetries ?? DEFAULT_FORWARD_RETRIES;
	}

	async execute(update: IncomingUpdate): Promise<boolean> {
		// ── Callback query → ruteo por prefijo ──
		if (update.callback_query) {
			return this.routeCallback(update);
		}

		const text = update.message?.text?.trim() ?? "";
		const chatId = String(update.message?.chat.id ?? "");

		// ── Comando → handler registrado ──
		const cmd = (text.split(/\s+/)[0] ?? "").replace(
			/@[a-zA-Z0-9_]+$/,
			"",
		);
		const wh = this.handlerRegistry.getHandler(cmd);
		if (wh) {
			this.logRouting(update, cmd, chatId, text);
			await this.forward(wh, update);
			return true;
		}

		// ── Fallback al handler por defecto ──
		const def = this.handlerRegistry.getHandler(DEFAULT_HANDLER);
		const caption = update.message?.caption;
		if (
			def &&
			(text ||
				caption ||
				update.message?.voice ||
				update.message?.audio ||
				update.message?.photo ||
				update.message?.document ||
				update.message?.video ||
				update.message?.sticker)
		) {
			this.logRouting(update, DEFAULT_HANDLER, chatId, text, caption);
			await this.forward(def, update);
			return true;
		}

		this.logRouting(
			update,
			"dropped",
			chatId,
			text,
			caption,
			text || caption || update.message?.voice || update.message?.audio ||
			update.message?.photo || update.message?.document || update.message?.video ||
			update.message?.sticker
				? "no-handler"
				: "empty",
		);
		return false;
	}

	// ── private ────────────────────────────────────────────────────────

	private async routeCallback(update: IncomingUpdate): Promise<boolean> {
		const data = update.callback_query?.data ?? "";
		const chatId = String(update.callback_query?.message?.chat.id ?? "");
		let prefix: string | undefined;
		const slashMatch = data.match(/^(\/[a-z0-9_]+)/);
		const wordMatch = data.match(/^([a-zA-Z0-9_]+)/);
		if (slashMatch) prefix = slashMatch[1]!;
		else if (wordMatch) prefix = wordMatch[1]!;
		if (prefix) {
			const wh = this.handlerRegistry.getHandler(prefix);
			if (wh) {
				this.logRouting(update, prefix, chatId, data);
				await this.forward(wh, update);
				return true;
			}
		}
		// Un callback sin handler específico cae al por defecto, igual que los
		// mensajes: el data es el comando que el usuario habría tecleado
		// ("/aprobar <id>"), así que el toque de un botón inline se trata como
		// texto. Sin este fallback el update se descartaba en silencio: el
		// spinner del botón se apagaba y no pasaba nada más. Se exige data no
		// vacío para no reenviar callbacks degenerados sin nada que procesar.
		if (data.trim()) {
			const def = this.handlerRegistry.getHandler(DEFAULT_HANDLER);
			if (def) {
				this.logRouting(update, DEFAULT_HANDLER, chatId, data);
				await this.forward(def, update);
				return true;
			}
		}
		this.logRouting(update, "dropped", chatId, data, undefined, data.trim() ? "no-handler" : "empty");
		return false;
	}

	private logRouting(
		update: IncomingUpdate,
		route: string,
		chatId: string,
		text?: string,
		caption?: string,
		reason?: "no-handler" | "empty",
	): void {
		const meta: Record<string, unknown> = {
			update_id: update.update_id,
			type: update.callback_query ? "callback" : "message",
			chatId,
			route,
		};
		if (reason) meta.reason = reason;
		const loggedText = truncateLogText(text);
		const loggedCaption = truncateLogText(caption);
		if (loggedText !== undefined) meta.text = loggedText;
		if (loggedCaption !== undefined) meta.caption = loggedCaption;
		logger.info("update routing", meta);
	}

	private async forward(webhook: string, update: IncomingUpdate) {
		await forwardUpdate(webhook, update, {
			timeoutMs: this.forwardTimeoutMs,
			retries: this.forwardRetries,
		});
	}
}
