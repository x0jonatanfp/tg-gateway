import { existsSync, readFileSync } from "node:fs";
import {
	ChatResolutionError,
	type ChatResolver,
} from "../domain/chat-resolver.ts";

const CHAT_KEY = "TG_ALLOWED_CHATS";

export interface DefaultChatResolverOptions {
	envFile: string;
	envDefaultChatId?: string;
}

/**
 * Prioridad: chat explícito > TG_DEFAULT_CHAT_ID del entorno > primer valor de
 * TG_ALLOWED_CHATS en el .env del gateway. Solo se lee esa clave del fichero.
 */
export function createDefaultChatResolver(
	options: DefaultChatResolverOptions,
): ChatResolver {
	return {
		resolve(explicitChat?: string): string {
			const explicit = explicitChat?.trim();
			if (explicit) return explicit;
			const fromEnv = options.envDefaultChatId?.trim();
			if (fromEnv) return fromEnv;
			const fromFile = firstListValue(envValue(options.envFile, CHAT_KEY));
			if (fromFile) return fromFile;
			throw new ChatResolutionError(
				`No se pudo resolver el chat privado por defecto: define TG_DEFAULT_CHAT_ID o ${CHAT_KEY} en ${options.envFile}.`,
			);
		},
	};
}

/** Lee una clave de un .env sin cargar el resto ni exponerlo. */
function envValue(file: string, key: string): string | undefined {
	if (!existsSync(file)) return undefined;
	let content: string;
	try {
		content = readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const separator = trimmed.indexOf("=");
		if (separator < 0) continue;
		if (trimmed.slice(0, separator).trim() !== key) continue;
		let value = trimmed.slice(separator + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		return value;
	}
	return undefined;
}

function firstListValue(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	for (const item of value.split(",")) {
		const trimmed = item.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}
