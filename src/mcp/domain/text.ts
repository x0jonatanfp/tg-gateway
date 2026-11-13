import { MAX_TEXT_LENGTH } from "./limits.ts";

/** Cómo se interpreta el texto que llega en `send_text`. */
export type ParseMode = "plain" | "html" | "markdown";

export const PARSE_MODES: readonly ParseMode[] = ["plain", "html", "markdown"];

/**
 * Escapa lo mínimo para enviar texto plano como HTML sin que Telegram
 * interprete etiquetas. Misma lógica que el helper `tg-send.mjs`.
 */
export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * Texto plano (por defecto) → HTML escapado, para que `_`, `*` o `<` no
 * rompan el mensaje. `html` y `markdown` pasan el texto tal cual: quien los
 * pide sabe lo que manda.
 */
export function prepareText(
	text: string,
	mode: ParseMode,
): { text: string; parseMode: "HTML" | "Markdown" } {
	if (mode === "markdown") return { text, parseMode: "Markdown" };
	if (mode === "html") return { text, parseMode: "HTML" };
	return { text: escapeHtml(text), parseMode: "HTML" };
}

export function textLengthError(length: number): string {
	return `El mensaje tiene ${length} caracteres; Telegram admite ${MAX_TEXT_LENGTH} como máximo. Pártelo en varios mensajes (no se ha enviado nada).`;
}
