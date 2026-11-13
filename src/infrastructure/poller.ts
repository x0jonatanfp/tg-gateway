import { logger } from "./logger.ts";
import type { IncomingUpdate } from "../domain/entities/message.ts";

// Timeout para el fetch de offset inicial. Este fetch debería responder
// rápido (es un GET simple, no long-polling). Si en 10 s no responde,
// probablemente la red esté caída y dejamos que systemd reintente.
const BOOT_FETCH_TIMEOUT_MS = 10_000;

export interface PollerConfig {
	token: string;
	timeout: number;
}

export class Poller {
	private offset = 0;
	private running = false;
	private apiBase: string;
	private timeout: number;

	constructor(
		config: PollerConfig,
		private onUpdate: (update: IncomingUpdate) => Promise<void>,
	) {
		this.apiBase = `https://api.telegram.org/bot${config.token}`;
		this.timeout = config.timeout;
	}

	async start(): Promise<void> {
		this.running = true;

		try {
			const res = await fetch(`${this.apiBase}/getUpdates?offset=0&limit=1`, {
				signal: AbortSignal.timeout(BOOT_FETCH_TIMEOUT_MS),
			});
			const raw = await res.json();
			const data = raw as { ok?: boolean; result?: IncomingUpdate[] };
			if (data?.result?.length) {
				this.offset = data.result[data.result.length - 1]!.update_id + 1;
			}
		} catch {
			/* ignore initial offset fetch */
		}

		logger.info("polling started");
		await this.poll();
	}

	stop(): void {
		this.running = false;
	}

	private async poll(): Promise<void> {
		const BASE_BACKOFF_MS = 2_000;
		const MAX_BACKOFF_MS = 30_000;
		let consecutiveFailures = 0;
		let backoffMs = BASE_BACKOFF_MS;

		while (this.running) {
			try {
				const url =
					`${this.apiBase}/getUpdates?offset=${this.offset}&timeout=${this.timeout}`;
				const res = await fetch(url, {
					signal: AbortSignal.timeout((this.timeout + 5) * 1_000),
				});
				const raw = await res.json();
				const data = raw as { ok?: boolean; result?: IncomingUpdate[] };

				// Poll correcto: volvemos al intervalo base.
				if (consecutiveFailures > 0) {
					logger.info("poll recovered", { failures: consecutiveFailures });
					consecutiveFailures = 0;
				}
				backoffMs = BASE_BACKOFF_MS;

				for (const update of data?.result ?? []) {
					this.offset = update.update_id + 1;
					try {
						await this.onUpdate(update);
					} catch (err) {
						logger.error("update handler error", {
							update_id: update.update_id,
							error: String(err),
						});
					}
				}
			} catch (err: unknown) {
				if (!this.running) break;
				const e = err as Error & {
					cause?: { code?: string; message?: string };
				};
				// Un TimeoutError del long-poll es el caso normal cuando Telegram
				// no tiene updates que entregar: no es un fallo y no se registra
				// (antes solo se silenciaba, ahora tampoco rompe la racha).
				if (e?.name !== "TimeoutError") {
					consecutiveFailures++;
					// `fetch failed` no dice nada: la causa real (ECONNRESET,
					// ETIMEDOUT, ENOTFOUND, EHOSTUNREACH…) viaja en `e.cause`.
					const level = consecutiveFailures === 1 ? "warn" : "debug";
					logger[level]("poll error, retrying", {
						error: e?.message,
						cause: e?.cause?.code ?? e?.cause?.message,
						backoffMs,
					});
				}
				await new Promise((r) => setTimeout(r, backoffMs));
				// Backoff exponencial con techo: en una caída larga no spameamos
				// el log ni martilleamos la red cada 2 s.
				backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
			}
		}
	}
}
