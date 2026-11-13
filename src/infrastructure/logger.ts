import winston from "winston";
import { currentRequestId } from "./request-context.ts";
import { redactWebhookCredentials } from "./redact.ts";

const redactWebhookFields = winston.format((info) => {
	if (typeof info.webhook === "string") {
		info.webhook = redactWebhookCredentials(info.webhook);
	}
	return info;
});

/**
 * Añade el `requestId` del contexto activo al registro.
 *
 * Solo se asigna cuando hay contexto: con `??=` una línea fuera de un request
 * acabaría con un ` {}` pegado al final en el formato de consola.
 */
export function addRequestId(
	info: winston.Logform.TransformableInfo,
): winston.Logform.TransformableInfo {
	const requestId = currentRequestId();
	if (requestId) info.requestId = requestId;
	return info;
}

const requestIdFields = winston.format(addRequestId);

function createTransports() {
	const transports: winston.transport[] = [
		new winston.transports.Console({
			format: winston.format.combine(
				winston.format.timestamp(),
				redactWebhookFields(),
				requestIdFields(),
				winston.format.printf(({ timestamp, level, message, ...meta }) => {
					const metaStr = Object.keys(meta).length
						? ` ${JSON.stringify(meta)}`
						: "";
					return `${timestamp} [${level.toUpperCase()}] ${message}${metaStr}`;
				}),
			),
		}),
	];

	const logFile = process.env.TG_LOG_FILE;
	if (logFile) {
		transports.push(
			new winston.transports.File({
				filename: logFile,
				format: winston.format.combine(
					winston.format.timestamp(),
					redactWebhookFields(),
					requestIdFields(),
					winston.format.json(),
				),
			}),
		);
	}

	return transports;
}

export const logger = winston.createLogger({
	level: process.env.LOG_LEVEL ?? "info",
	transports: createTransports(),
});

export type Logger = winston.Logger;
