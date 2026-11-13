/**
 * Resuelve el destino de un envío: el chat explícito si lo hay y, si no, el
 * chat privado configurado. Nunca debe exponer el valor en respuestas ni logs.
 */
export interface ChatResolver {
	resolve(explicitChat?: string): string;
}

export class ChatResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ChatResolutionError";
	}
}
