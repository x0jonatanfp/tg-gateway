// Fuente única de las acciones de la tool `telegram` y de sus parámetros.
// La validación y el test de coherencia con el esquema la usan: al añadir un
// parámetro hay que tocar aquí, en `tool-definitions.ts` y en el caso de uso.

export const VALID_ACTIONS = [
	"status",
	"send_text",
	"send_photo",
	"send_video",
	"send_album",
	"edit_buttons",
	"delete_message",
] as const;

export type TelegramAction = (typeof VALID_ACTIONS)[number];

export interface ActionParamSpec {
	/** Parámetros que la acción exige. */
	required: readonly string[];
	/** Parámetros que la acción acepta sin exigirlos. */
	optional: readonly string[];
	/** true si la acción escribe en Telegram (todo salvo status). */
	writes: boolean;
}

export const ACTION_PARAMS: Record<TelegramAction, ActionParamSpec> = {
	status: { required: [], optional: [], writes: false },
	send_text: {
		required: ["text"],
		optional: ["parse_mode", "chat"],
		writes: true,
	},
	send_photo: {
		required: ["file_path"],
		optional: ["caption", "chat"],
		writes: true,
	},
	send_video: {
		required: ["file_path"],
		optional: ["caption", "chat"],
		writes: true,
	},
	send_album: {
		required: ["file_paths"],
		optional: ["caption", "chat"],
		writes: true,
	},
	edit_buttons: {
		required: ["message_id"],
		optional: ["reply_markup", "chat"],
		writes: true,
	},
	delete_message: {
		required: ["message_id"],
		optional: ["chat"],
		writes: true,
	},
};

export function isTelegramAction(value: string): value is TelegramAction {
	return (VALID_ACTIONS as readonly string[]).includes(value);
}

export function actionParamList(action: TelegramAction): string[] {
	const spec = ACTION_PARAMS[action];
	return [...spec.required, ...spec.optional];
}
