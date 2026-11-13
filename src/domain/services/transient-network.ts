// Detección de errores que indican problemas transitorios de red y que
// justifican un reintento con backoff. Lo usan tanto telegram-client.ts
// (en tgFetch) como handle-update.ts (en forward()). Mantenerlo aquí evita
// que las dos implementaciones se desincronicen cuando se sume un nuevo
// caller o aparezca un nuevo código relevante.

const TRANSIENT_NETWORK_CODES = new Set([
	"ECONNRESET",
	"ETIMEDOUT",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"EPIPE",
	"UND_ERR_SOCKET",
	"UND_ERR_CONNECT_TIMEOUT",
]);

export function isTransientNetworkError(err: unknown): boolean {
	const e = err as Error & {
		name?: string;
		cause?: { code?: string; message?: string };
	};
	if (e?.name === "TimeoutError" || e?.name === "AbortError") return true;
	if (e?.cause?.code && TRANSIENT_NETWORK_CODES.has(e.cause.code)) return true;
	// undici en Node ≥ 18 envuelve los errores de socket como
	// `TypeError: fetch failed`. La causa real va en `err.cause`.
	if (String(e?.message ?? e).includes("fetch failed")) return true;
	return false;
}

// Backoff exponencial con jitter ±20%. Evita que N coroutines reintenten
// sincronizados contra un endpoint recién caído (thundering herd).
export function backoffWithJitter(attempt: number): number {
	const base = 250 * Math.pow(2, attempt);
	const jitter = base * 0.4 * (Math.random() - 0.5);
	return Math.max(50, Math.round(base + jitter));
}
