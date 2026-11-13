/**
 * Redacta las credenciales embebidas en una URL antes de escribirla en logs
 * o devolverla por una API de diagnóstico.
 */
export function redactWebhookCredentials(webhook: string): string {
	try {
		const url = new URL(webhook);
		if (!url.username && !url.password) return webhook;
		url.username = url.username ? "***" : "";
		url.password = url.password ? "***" : "";
		return url.toString();
	} catch {
		return webhook;
	}
}
