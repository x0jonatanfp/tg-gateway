import type { HandlerRegistryPort } from "../domain/ports/handlers.ts";
import type { IncomingUpdate } from "../domain/entities/message.ts";

interface HandlerEntry {
	command: string;
	webhook: string;
}

export class HandlerRegistry implements HandlerRegistryPort {
	private handlers = new Map<string, string>();

	register(command: string, webhook: string): void {
		this.handlers.set(command, webhook);
	}

	unregister(command: string): void {
		this.handlers.delete(command);
	}

	getHandler(command: string): string | undefined {
		return this.handlers.get(command);
	}

	list(): HandlerEntry[] {
		return Array.from(this.handlers.entries()).map(([command, webhook]) => ({
			command,
			webhook,
		}));
	}
}
