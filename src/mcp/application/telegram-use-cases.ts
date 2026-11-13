import {
	ACTION_PARAMS,
	type TelegramAction,
	VALID_ACTIONS,
	actionParamList,
	isTelegramAction,
} from "../domain/action-params.ts";
import {
	ChatResolutionError,
	type ChatResolver,
} from "../domain/chat-resolver.ts";
import {
	GatewayUnavailableError,
	GatewayUnexpectedResponseError,
	TelegramRejectedError,
} from "../domain/gateway-errors.ts";
import { MAX_CAPTION_LENGTH, MAX_TEXT_LENGTH } from "../domain/limits.ts";
import type { MediaFileProbe } from "../domain/media-file-probe.ts";
import {
	type MediaKind,
	albumCountError,
	validateMediaPath,
} from "../domain/media.ts";
import {
	type ParseMode,
	prepareText,
	textLengthError,
} from "../domain/text.ts";
import type { TgGatewayPort } from "../domain/tg-gateway-port.ts";
import { type ToolOutcome, fail, ok } from "./outcome.ts";

export interface TelegramUseCaseDeps {
	gateway: TgGatewayPort;
	chat: ChatResolver;
	files: MediaFileProbe;
}

type ResolvedChat =
	| { ok: true; chatId: string }
	| { ok: false; outcome: ToolOutcome };

function str(params: Record<string, unknown>, key: string): string | undefined {
	const value = params[key];
	return typeof value === "string" ? value : undefined;
}

function resolveChat(
	deps: TelegramUseCaseDeps,
	params: Record<string, unknown>,
): ResolvedChat {
	const explicit = str(params, "chat")?.trim() || undefined;
	try {
		return { ok: true, chatId: deps.chat.resolve(explicit) };
	} catch (err) {
		if (err instanceof ChatResolutionError) {
			return { ok: false, outcome: fail(err.message) };
		}
		return {
			ok: false,
			outcome: fail("No se pudo resolver el chat privado por defecto."),
		};
	}
}

function captionParam(params: Record<string, unknown>): {
	value?: string;
	error?: string;
} {
	const raw = params.caption;
	if (raw === undefined || raw === null) return {};
	if (typeof raw !== "string") return { error: "caption debe ser texto." };
	if (raw.trim() === "") return {};
	if (raw.length > MAX_CAPTION_LENGTH) {
		return {
			error: `El caption tiene ${raw.length} caracteres; Telegram admite ${MAX_CAPTION_LENGTH} como máximo. Acórtalo.`,
		};
	}
	return { value: raw };
}

function messageIdParam(params: Record<string, unknown>): number | undefined {
	const value = params.message_id;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		return undefined;
	}
	return value;
}

async function status(gateway: TgGatewayPort): Promise<ToolOutcome> {
	const health = await gateway.health();
	const uptime = Math.round(health.uptimeSeconds);
	if (!health.ok) {
		const breaker = health.breaker
			? ` Circuit breaker: ${health.breaker.state}, ${health.breaker.failures} fallo(s).`
			: "";
		return fail(
			`tg-gateway vivo (uptime ${uptime} s) pero Telegram no responde.${breaker}`,
		);
	}
	return ok(`tg-gateway OK: Telegram responde. uptime: ${uptime} s.`);
}

async function sendText(
	deps: TelegramUseCaseDeps,
	params: Record<string, unknown>,
): Promise<ToolOutcome> {
	const raw = str(params, "text");
	if (raw === undefined || raw.trim() === "") {
		return fail("text es obligatorio y no puede estar vacío.");
	}
	if (raw.length > MAX_TEXT_LENGTH) return fail(textLengthError(raw.length));

	const modeRaw = params.parse_mode;
	let mode: ParseMode = "plain";
	if (modeRaw !== undefined) {
		if (modeRaw !== "plain" && modeRaw !== "html" && modeRaw !== "markdown") {
			return fail("parse_mode debe ser plain, html o markdown.");
		}
		mode = modeRaw;
	}
	const prepared = prepareText(raw, mode);
	if (prepared.text.length > MAX_TEXT_LENGTH) {
		return fail(
			`El texto escapado ocupa ${prepared.text.length} caracteres; Telegram admite ${MAX_TEXT_LENGTH}. Acórtalo o pártelo.`,
		);
	}

	const resolved = resolveChat(deps, params);
	if (!resolved.ok) return resolved.outcome;
	const result = await deps.gateway.sendText({
		chatId: resolved.chatId,
		text: prepared.text,
		parseMode: prepared.parseMode,
	});
	return ok(`Mensaje enviado. message_id: ${result.messageId}`);
}

async function sendMedia(
	deps: TelegramUseCaseDeps,
	params: Record<string, unknown>,
	kind: MediaKind,
): Promise<ToolOutcome> {
	const filePath = str(params, "file_path")?.trim();
	if (!filePath) return fail("file_path es obligatorio.");
	const invalidPath = validateMediaPath(filePath, kind);
	if (invalidPath) return fail(invalidPath);
	if (!deps.files.exists(filePath)) {
		return fail(`No existe el archivo o no es un fichero regular: ${filePath}`);
	}

	const caption = captionParam(params);
	if (caption.error) return fail(caption.error);

	const resolved = resolveChat(deps, params);
	if (!resolved.ok) return resolved.outcome;
	const input = {
		chatId: resolved.chatId,
		filePath,
		...(caption.value ? { caption: caption.value } : {}),
	};
	const result =
		kind === "photo"
			? await deps.gateway.sendPhoto(input)
			: await deps.gateway.sendVideo(input);
	const label = kind === "photo" ? "Foto enviada" : "Vídeo enviado";
	return ok(`${label}. message_id: ${result.messageId}`);
}

async function sendAlbum(
	deps: TelegramUseCaseDeps,
	params: Record<string, unknown>,
): Promise<ToolOutcome> {
	const rawList = params.file_paths;
	if (!Array.isArray(rawList) || rawList.length === 0) {
		return fail(
			"file_paths es obligatorio (de 2 a 10 rutas absolutas de fotos).",
		);
	}
	const filePaths = rawList.map((value) =>
		typeof value === "string" ? value.trim() : "",
	);
	if (filePaths.some((filePath) => filePath === "")) {
		return fail("file_paths solo admite rutas de texto no vacías.");
	}
	const countError = albumCountError(filePaths.length);
	if (countError) return fail(countError);
	for (const filePath of filePaths) {
		const invalidPath = validateMediaPath(filePath, "photo");
		if (invalidPath) return fail(invalidPath);
		if (!deps.files.exists(filePath)) {
			return fail(
				`No existe el archivo o no es un fichero regular: ${filePath}`,
			);
		}
	}

	const caption = captionParam(params);
	if (caption.error) return fail(caption.error);

	const resolved = resolveChat(deps, params);
	if (!resolved.ok) return resolved.outcome;
	const result = await deps.gateway.sendAlbum({
		chatId: resolved.chatId,
		filePaths,
		...(caption.value ? { caption: caption.value } : {}),
	});
	return ok(
		`Álbum enviado (${filePaths.length} fotos). message_id: ${result.messageId}`,
	);
}

async function editButtons(
	deps: TelegramUseCaseDeps,
	params: Record<string, unknown>,
): Promise<ToolOutcome> {
	const messageId = messageIdParam(params);
	if (messageId === undefined) {
		return fail("message_id es obligatorio (entero positivo).");
	}
	const rawMarkup = params.reply_markup;
	let replyMarkup: Record<string, unknown> = {};
	if (rawMarkup !== undefined && rawMarkup !== null) {
		if (typeof rawMarkup !== "object" || Array.isArray(rawMarkup)) {
			return fail("reply_markup debe ser un objeto JSON de Telegram.");
		}
		replyMarkup = rawMarkup as Record<string, unknown>;
	}
	const hasButtons = Object.keys(replyMarkup).length > 0;

	const resolved = resolveChat(deps, params);
	if (!resolved.ok) return resolved.outcome;
	await deps.gateway.editButtons({
		chatId: resolved.chatId,
		messageId,
		replyMarkup,
	});
	return ok(
		`Botones ${hasButtons ? "actualizados" : "eliminados"}. message_id: ${messageId}`,
	);
}

async function deleteMessage(
	deps: TelegramUseCaseDeps,
	params: Record<string, unknown>,
): Promise<ToolOutcome> {
	const messageId = messageIdParam(params);
	if (messageId === undefined) {
		return fail("message_id es obligatorio (entero positivo).");
	}

	const resolved = resolveChat(deps, params);
	if (!resolved.ok) return resolved.outcome;
	await deps.gateway.deleteMessage({ chatId: resolved.chatId, messageId });
	return ok(`Mensaje ${messageId} borrado.`);
}

function gatewayFailure(err: unknown, action: TelegramAction): ToolOutcome {
	const operation =
		action === "status"
			? "la consulta"
			: action === "edit_buttons" || action === "delete_message"
				? "la operación"
				: "el envío";
	if (err instanceof TelegramRejectedError) {
		return fail(`Telegram rechazó ${operation}.`);
	}
	if (err instanceof GatewayUnavailableError) {
		return fail("tg-gateway caído o sin respuesta.");
	}
	if (err instanceof GatewayUnexpectedResponseError) {
		const status = err.status === undefined ? "" : ` (HTTP ${err.status})`;
		return fail(
			`tg-gateway devolvió una respuesta inesperada${status}. No lo des por hecho.`,
		);
	}
	return fail("Error inesperado al hablar con tg-gateway.");
}

async function dispatch(
	deps: TelegramUseCaseDeps,
	action: TelegramAction,
	params: Record<string, unknown>,
): Promise<ToolOutcome> {
	switch (action) {
		case "status":
			return status(deps.gateway);
		case "send_text":
			return sendText(deps, params);
		case "send_photo":
			return sendMedia(deps, params, "photo");
		case "send_video":
			return sendMedia(deps, params, "video");
		case "send_album":
			return sendAlbum(deps, params);
		case "edit_buttons":
			return editButtons(deps, params);
		case "delete_message":
			return deleteMessage(deps, params);
	}
}

/**
 * Despacha `telegram(action, params)`. Todo el envío pasa por aquí: validación
 * local primero y, solo si está limpio, una llamada al gateway.
 */
export async function runTelegramAction(
	deps: TelegramUseCaseDeps,
	action: string,
	params: Record<string, unknown>,
): Promise<ToolOutcome> {
	if (!isTelegramAction(action)) {
		return fail(
			`Acción desconocida: '${action}'. Acciones válidas: ${VALID_ACTIONS.join(", ")}.`,
		);
	}

	const allowed = actionParamList(action);
	const unknown = Object.keys(params).filter((key) => !allowed.includes(key));
	if (unknown.length > 0) {
		const valid = allowed.length > 0 ? allowed.join(", ") : "ninguno";
		return fail(
			`Parámetros desconocidos en ${action}: ${unknown.join(", ")}. Los válidos son: ${valid}.`,
		);
	}

	const spec = ACTION_PARAMS[action];
	const missing = spec.required.filter(
		(key) => params[key] === undefined || params[key] === null,
	);
	if (missing.length > 0) {
		const verb = missing.length === 1 ? "es obligatorio" : "son obligatorios";
		return fail(`${missing.join(", ")} ${verb}.`);
	}

	try {
		return await dispatch(deps, action, params);
	} catch (err) {
		return gatewayFailure(err, action);
	}
}
