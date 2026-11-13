export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:4000";

export interface TgMcpConfig {
	gatewayUrl: string;
	/** Fichero del que se lee TG_ALLOWED_CHATS (solo esa clave). */
	envFile: string;
	/** Valor de TG_DEFAULT_CHAT_ID, si está definido en el entorno. */
	defaultChatId: string | undefined;
}

/**
 * Configuración del entorno. No lee secretos ni ficheros: solo nombres.
 *
 * `defaultEnvFile` lo calcula el punto de entrada desde `import.meta.url`: el
 * `.env` que hay junto a la instalación. Este módulo no puede resolverlo por su
 * cuenta, porque un `.env` relativo al directorio de trabajo leería el del
 * proyecto desde el que se lanzó el servidor (o ninguno). Sin
 * `TG_GATEWAY_ENV_FILE` ni `defaultEnvFile` queda vacío y el chat solo puede
 * salir de `TG_DEFAULT_CHAT_ID`.
 */
export function loadTgMcpConfig(
	env: Record<string, string | undefined> = process.env,
	defaultEnvFile = "",
): TgMcpConfig {
	return {
		gatewayUrl: env.TG_GATEWAY_URL?.trim() || DEFAULT_GATEWAY_URL,
		envFile: env.TG_GATEWAY_ENV_FILE?.trim() || defaultEnvFile.trim(),
		defaultChatId: env.TG_DEFAULT_CHAT_ID?.trim() || undefined,
	};
}
