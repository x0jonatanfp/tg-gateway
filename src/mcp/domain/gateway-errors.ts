/** El gateway no responde, respondió 500 o se cortó la conexión. */
export class GatewayUnavailableError extends Error {
	constructor() {
		super("tg-gateway caído o sin respuesta");
		this.name = "GatewayUnavailableError";
	}
}

/** El gateway respondió 502: Telegram rechazó la operación. */
export class TelegramRejectedError extends Error {
	constructor() {
		super("Telegram rechazó la operación");
		this.name = "TelegramRejectedError";
	}
}

/** Respuesta inesperada (HTTP raro o JSON sin `ok`/`result` válidos). */
export class GatewayUnexpectedResponseError extends Error {
	readonly status?: number;

	constructor(status?: number) {
		super(
			status === undefined
				? "respuesta inesperada de tg-gateway"
				: `tg-gateway HTTP ${status}`,
		);
		this.name = "GatewayUnexpectedResponseError";
		this.status = status;
	}
}
