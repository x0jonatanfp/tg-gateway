#!/usr/bin/env node
/**
 * Helper para enviar texto, foto o vídeo por el tg-gateway local.
 *
 * Resuelve el chat privado por defecto leyendo la configuración real (sin
 * imprimirla), hace la llamada HTTP y comprueba la respuesta real del gateway.
 *
 * Uso:
 *   node tg-send.mjs --status
 *   node tg-send.mjs --text "mensaje" [--html|--markdown] [--chat ID]
 *   node tg-send.mjs --file /ruta/foto.jpg --type photo [--caption "..."]
 *   node tg-send.mjs --file /ruta/video.mp4 --type video [--caption "..."]
 *   node tg-send.mjs --files a.jpg b.jpg [c.jpg ...] [--caption "..."]
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_TEXT_LENGTH = 4096;
const MAX_CAPTION_LENGTH = 1024;
// De dónde sale el chat privado por defecto: primero los chats permitidos del
// gateway (TG_ALLOWED_CHATS en su env file) y luego, si se declaran, los env
// files de otros servicios que guardan un único TELEGRAM_CHAT_ID.
//
// El default se calcula desde la ruta de este script, nunca desde el cwd: los
// cron lo lanzan desde directorios arbitrarios y un `.env` relativo leería el de
// otro proyecto. En dist/tg-send.mjs resuelve a <install>/.env, el mismo que
// carga el servicio.
export function defaultEnvFileFor(scriptUrl) {
	return fileURLToPath(new URL("../.env", scriptUrl));
}

const DEFAULT_ENV_FILE = defaultEnvFileFor(import.meta.url);

function chatSources() {
	const gatewayEnvFile =
		process.env.TG_GATEWAY_ENV_FILE?.trim() || DEFAULT_ENV_FILE;
	const extra = (process.env.TG_CHAT_ID_ENV_FILES ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	return [
		{ file: gatewayEnvFile, key: "TG_ALLOWED_CHATS", takeFirstOfList: true },
		...extra.map((file) => ({ file, key: "TELEGRAM_CHAT_ID" })),
	];
}

function usage(message) {
	if (message) console.error(message);
	console.error(
		[
			"Uso:",
			"  node tg-send.mjs --status",
			"  node tg-send.mjs --text <texto> [--html|--markdown] [--chat <id|@usuario>]",
			"  node tg-send.mjs --file <ruta> --type photo|video [--caption <texto>]",
			"  node tg-send.mjs --files <ruta...> [--caption <texto>]  (álbum, 2-10 fotos)",
			"",
			"Opciones:",
			"  --url <base>      URL del gateway (default: env TG_GATEWAY_URL o http://127.0.0.1:4000)",
			"  --chat <destino>  destino explícito (por defecto se resuelve el chat privado)",
			"",
			"Entorno:",
			"  TG_GATEWAY_ENV_FILE   env file del gateway (default: el .env junto a la instalación)",
			"  TG_CHAT_ID_ENV_FILES  env files con TELEGRAM_CHAT_ID, separados por comas",
		].join("\n"),
	);
	process.exit(2);
}

function parseArgs(argv) {
	const args = {
		action: null,
		url: process.env.TG_GATEWAY_URL || "http://127.0.0.1:4000",
		text: undefined,
		file: undefined,
		files: undefined,
		type: undefined,
		caption: undefined,
		chat: undefined,
		format: "plain",
	};

	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--status":
				args.action = "status";
				break;
			case "--text":
				args.action = "text";
				args.text = argv[++i];
				break;
			case "--file":
				args.action = "file";
				args.file = argv[++i];
				break;
			case "--files":
				args.action = "album";
				args.files = [];
				while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
					args.files.push(argv[++i]);
				}
				break;
			case "--type":
				args.type = argv[++i];
				break;
			case "--caption":
				args.caption = argv[++i];
				break;
			case "--chat":
				args.chat = argv[++i];
				break;
			case "--url":
				args.url = argv[++i];
				break;
			case "--html":
				args.format = "html";
				break;
			case "--markdown":
				args.format = "markdown";
				break;
			default:
				usage(`Argumento desconocido: ${arg}`);
		}
	}

	if (!args.action) usage("Falta --status, --text, --file o --files.");
	if (args.action === "text" && typeof args.text !== "string") {
		usage("--text requiere un valor.");
	}
	if (args.action === "file") {
		if (!args.file) usage("--file requiere una ruta.");
		if (args.type !== "photo" && args.type !== "video") {
			usage("--file requiere --type photo o --type video.");
		}
	}
	if (args.action === "album") {
		if (!args.files || args.files.length < 2 || args.files.length > 10) {
			usage("--files requiere entre 2 y 10 rutas de foto.");
		}
	}
	return args;
}

function envValue(file, key) {
	if (!existsSync(file)) return undefined;
	const pattern = new RegExp(
		`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(.*?)\\s*$`,
	);
	for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
		const match = line.match(pattern);
		if (!match) continue;
		let value = match[1];
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

function firstListValue(value) {
	if (value == null) return undefined;
	for (const item of value.split(",")) {
		const trimmed = item.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}

function resolveChat(explicitChat) {
	if (explicitChat) return explicitChat;
	for (const source of chatSources()) {
		const value = envValue(source.file, source.key);
		const candidate = source.takeFirstOfList
			? firstListValue(value)
			: value?.trim();
		if (candidate) return candidate;
	}
	throw new Error(
		"No se pudo resolver el chat privado por defecto. Define TG_ALLOWED_CHATS en TG_GATEWAY_ENV_FILE o TELEGRAM_CHAT_ID en TG_CHAT_ID_ENV_FILES.",
	);
}

function escapeHtml(text) {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function validateFile(file, type) {
	if (!existsSync(file)) {
		throw new Error(`El archivo no existe: ${file}`);
	}
	if (!statSync(file).isFile()) {
		throw new Error(`No es un archivo regular: ${file}`);
	}
	const lower = file.toLowerCase();
	if (type === "photo" && !/\.(jpe?g|png)$/.test(lower)) {
		throw new Error(
			"send-photo del gateway solo etiqueta bien .jpg/.jpeg/.png; usa una de esas extensiones.",
		);
	}
	if (type === "video" && !/\.mp4$/i.test(lower)) {
		throw new Error("send-video del gateway etiqueta el archivo como MP4; usa .mp4.");
	}
}

async function postJson(url, path, payload) {
	let response;
	try {
		response = await fetch(`${url}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(60_000),
		});
	} catch (error) {
		throw new Error(
			`No se pudo conectar con tg-gateway en ${url} (¿está caído? systemctl status tg-gateway): ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	let body;
	try {
		body = await response.json();
	} catch {
		body = { ok: false, error: `HTTP ${response.status} sin JSON` };
	}
	if (!response.ok || !body.ok || body.result == null) {
		const detail =
			typeof body.error === "string"
				? body.error
				: JSON.stringify(body);
		throw new Error(`tg-gateway respondió HTTP ${response.status}: ${detail}`);
	}
	return body;
}

async function sendText(args) {
	const chatId = resolveChat(args.chat);
	if (!args.text.trim()) throw new Error("El texto está vacío.");
	if (args.text.length > MAX_TEXT_LENGTH) {
		throw new Error(
			`El mensaje tiene ${args.text.length} caracteres; Telegram admite máximo ${MAX_TEXT_LENGTH}. Pártelo en varios mensajes.`,
		);
	}

	const payload = { chat_id: chatId, text: args.text };
	if (args.format === "html") {
		payload.parse_mode = "HTML";
	} else if (args.format === "markdown") {
		payload.parse_mode = "Markdown";
	} else {
		// Texto plano seguro: HTML escapado para que nada se interprete.
		payload.parse_mode = "HTML";
		payload.text = escapeHtml(args.text);
	}

	const body = await postJson(args.url, "/api/send", payload);
	console.log(`Mensaje enviado. message_id: ${body.result.messageId}`);
}

async function sendFile(args) {
	const chatId = resolveChat(args.chat);
	validateFile(args.file, args.type);
	if (args.caption && args.caption.length > MAX_CAPTION_LENGTH) {
		throw new Error(
			`El caption tiene ${args.caption.length} caracteres; Telegram admite máximo ${MAX_CAPTION_LENGTH}.`,
		);
	}
	// El gateway lee el fichero desde SU directorio de trabajo: hay que mandarle
	// la ruta ABSOLUTA. Con una ruta relativa responde ENOENT y el helper lo
	// traduce como un «Telegram rechazó el envío» que no tiene nada que ver
	// (comprobado el 10-09-2026 con una lámina de charts/).
	const payload = { chat_id: chatId, file_path: path.resolve(args.file) };
	if (args.caption) payload.caption = args.caption;
	const endpoint = args.type === "photo" ? "/api/send-photo" : "/api/send-video";
	const body = await postJson(args.url, endpoint, payload);
	console.log(
		`${args.type === "photo" ? "Foto" : "Vídeo"} enviado. message_id: ${body.result.messageId}`,
	);
}

async function sendAlbum(args) {
	const chatId = resolveChat(args.chat);
	for (const file of args.files) validateFile(file, "photo");
	if (args.caption && args.caption.length > MAX_CAPTION_LENGTH) {
		throw new Error(
			`El caption tiene ${args.caption.length} caracteres; Telegram admite máximo ${MAX_CAPTION_LENGTH} en el pie de un álbum.`,
		);
	}
	// Rutas absolutas: el gateway lee los ficheros desde SU cwd (ver sendFile).
	const payload = {
		chat_id: chatId,
		file_paths: args.files.map((file) => path.resolve(file)),
	};
	if (args.caption) payload.caption = args.caption;
	const body = await postJson(args.url, "/api/send-media-group", payload);
	console.log(
		`Álbum enviado (${args.files.length} fotos). message_id: ${body.result.messageId}`,
	);
}

async function status(args) {
	let response;
	try {
		response = await fetch(`${args.url}/health`, {
			signal: AbortSignal.timeout(10_000),
		});
	} catch (error) {
		throw new Error(
			`tg-gateway no responde en ${args.url}. Comprueba systemctl status tg-gateway.`,
		);
	}
	const body = await response.json().catch(() => null);
	if (!response.ok || !body?.ok) {
		throw new Error(`tg-gateway health falló: HTTP ${response.status}`);
	}
	console.log(`tg-gateway OK. uptime: ${Math.round(body.uptime)} s`);
}

async function main() {
	const args = parseArgs(process.argv);
	if (args.action === "status") {
		await status(args);
	} else if (args.action === "text") {
		await sendText(args);
	} else if (args.action === "file") {
		await sendFile(args);
	} else if (args.action === "album") {
		await sendAlbum(args);
	}
}

// Solo corre como programa: importarlo desde un test no debe lanzar el CLI ni
// tocar process.exit.
//
// Se comparan rutas REALES: si se invoca por un enlace simbólico, `argv[1]` es
// la ruta del enlace e `import.meta.url` la del fichero real. Sin resolverlo, el
// script salía con código 0 sin ejecutar nada — fallo silencioso inaceptable en
// algo que lanzan tareas programadas.
function isMainModule(argvPath, moduleUrl) {
	if (!argvPath) return false;
	let real;
	try {
		real = realpathSync(argvPath);
	} catch {
		return false;
	}
	return pathToFileURL(real).href === moduleUrl;
}

if (isMainModule(process.argv[1], import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
