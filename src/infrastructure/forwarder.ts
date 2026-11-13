import { logger } from "./logger.ts";
import { redactWebhookCredentials } from "./redact.ts";
import type { IncomingUpdate } from "../domain/entities/message.ts";
import {
	backoffWithJitter,
	isTransientNetworkError,
} from "../domain/services/transient-network.ts";

export interface ForwardOptions {
	timeoutMs?: number;
	retries?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 0;

/**
 * POST an update to a webhook URL with optional retry on transient network errors.
 * 4xx/5xx responses are never retried — the receiver may have partially processed
 * the payload and a retry would duplicate non-idempotent side effects.
 */
export async function forwardUpdate(
	webhook: string,
	update: IncomingUpdate,
	options: ForwardOptions = {},
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const retries = options.retries ?? DEFAULT_RETRIES;

	// Node.js fetch rechaza URLs con credenciales embebidas. Las extraemos,
	// limpiamos la URL y las enviamos como Authorization: Basic.
	const parsedUrl = new URL(webhook);
	const cleanUrl = parsedUrl.username || parsedUrl.password
		? (() => {
				const u = new URL(webhook);
				u.username = "";
				u.password = "";
				return u.toString();
			})()
		: webhook;
	const extraHeaders: Record<string, string> = {};
	if (parsedUrl.username || parsedUrl.password) {
		const user = decodeURIComponent(parsedUrl.username);
		const pass = decodeURIComponent(parsedUrl.password);
		extraHeaders["Authorization"] = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
	}

	for (let attempt = 0; ; attempt++) {
		try {
			const res = await fetch(cleanUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...extraHeaders },
				body: JSON.stringify(update),
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (res.ok) return;
			// 4xx/5xx: NO se reintenta. El receptor puede haber procesado
			// parcialmente y un retry duplicaría efectos no idempotentes.
			logger.warn("forward failed", {
				webhook: redactWebhookCredentials(webhook),
				status: res.status,
				attempt,
			});
			return;
		} catch (err) {
			const transient = isTransientNetworkError(err);
			const isLast = attempt >= retries;
			if (isLast || !transient) {
				logger.error("forward error", {
					webhook: redactWebhookCredentials(webhook),
					error: String(err),
					transient,
					attempt,
				});
				return;
			}
			const delay = backoffWithJitter(attempt);
			const cause = (err as Error & { cause?: { code?: string } })
				?.cause?.code;
			logger.warn("forward retry", {
				webhook: redactWebhookCredentials(webhook),
				attempt: attempt + 1,
				delay,
				cause,
			});
			await new Promise((r) => setTimeout(r, delay));
		}
	}
}
