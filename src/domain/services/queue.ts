/**
 * Cola FIFO con rate limiting para Telegram.
 * Domain service: lógica pura, sin efectos secundarios.
 */
export interface QueuedTask<T = unknown> {
	id: string;
	task: () => Promise<T>;
	timestamp: number;
}

export class QueueService {
	private chain: Promise<unknown> = Promise.resolve();
	private lastSentAt = 0;

	constructor(private minIntervalMs: number) {}

	/**
	 * Encola una tarea y la ejecuta respetando el intervalo mínimo.
	 * Mantiene la cadena viva aunque una tarea falle.
	 */
	async enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.chain.then(async () => {
			const wait = this.minIntervalMs - (Date.now() - this.lastSentAt);
			if (wait > 0) await new Promise((r) => setTimeout(r, wait));
			try {
				return await task();
			} finally {
				this.lastSentAt = Date.now();
			}
		});
		this.chain = run.catch(() => {});
		return run;
	}
}
