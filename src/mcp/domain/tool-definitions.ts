import { VALID_ACTIONS } from "./action-params.ts";

// Una sola tool `telegram` con `action` + `params`, como life-mcp.
// La descripción deja explícito lo que no puede olvidar el agente: no se
// envía nada si el usuario no lo ha pedido en ese mismo momento.

export const TELEGRAM_TOOL_NAME = "telegram";

export const TELEGRAM_TOOL_ANNOTATIONS = {
	readOnlyHint: false,
	destructiveHint: true,
	openWorldHint: true,
};

export const TELEGRAM_TOOL_DEFINITION = {
	name: TELEGRAM_TOOL_NAME,
	description:
		"Telegram privado vía tg-gateway: action+params. SOLO envía si el usuario lo ha pedido expresamente en ese mismo momento; nunca de forma proactiva. " +
		"status(): salud del gateway, sin datos privados. " +
		"send_text(text,parse_mode?=plain|html|markdown): texto plano escapado a HTML por defecto; máx 4096, no trunca. " +
		"send_photo(file_path,caption?): .jpg/.jpeg/.png, caption máx 1024. " +
		"send_video(file_path,caption?): .mp4. " +
		"send_album(file_paths 2-10,caption?): varias fotos juntas en un mensaje; opción recomendada si van juntas. " +
		"edit_buttons(message_id,reply_markup?): cambia botones; sin reply_markup o {} los quita. " +
		"delete_message(message_id). " +
		"file_path y file_paths: rutas absolutas locales al gateway. chat solo si se pide otro destino; por defecto, el chat privado configurado.",
	parameters: {
		type: "object",
		properties: {
			action: {
				type: "string",
				enum: [...VALID_ACTIONS],
				description: "Which operation to run.",
			},
			params: {
				type: "object",
				description: "Arguments for the action (see the action list).",
				properties: {
					text: {
						type: "string",
						description:
							"Texto del mensaje. Máximo 4096 caracteres: si no cabe, pártelo. Acción: send_text.",
					},
					parse_mode: {
						type: "string",
						enum: ["plain", "html", "markdown"],
						description:
							"plain (por defecto) escapa el texto a HTML; html envía HTML propio; markdown usa Markdown de Telegram. Acción: send_text.",
					},
					file_path: {
						type: "string",
						description:
							"Ruta absoluta local al gateway, existente. Acciones: send_photo (.jpg/.jpeg/.png) y send_video (.mp4).",
					},
					file_paths: {
						type: "array",
						items: { type: "string" },
						description:
							"De 2 a 10 rutas absolutas de fotos; el caption va en la primera. Acción: send_album.",
					},
					caption: {
						type: "string",
						description:
							"Pie del mensaje en texto plano, máximo 1024 caracteres. Acciones: send_photo, send_video y send_album.",
					},
					message_id: {
						type: "number",
						description:
							"Id del mensaje de Telegram (entero positivo). Acciones: edit_buttons y delete_message.",
					},
					reply_markup: {
						type: "object",
						description:
							'Teclado inline de Telegram, p. ej. {"inline_keyboard":[[{"text":"Sí","callback_data":"approve"}]]}. Sin él o con {} se quitan los botones. Acción: edit_buttons.',
					},
					chat: {
						type: "string",
						description:
							"Destino explícito (id numérico o @usuario). Omítelo para el chat privado configurado; no lo inventes.",
					},
				},
			},
		},
		required: ["action"],
	},
} as const;
