import type { IncomingUpdate } from "../entities/message.ts";

export type HandlerResult = { handled: boolean };

export interface UpdateHandler {
	canHandle(update: IncomingUpdate): boolean;
	handle(update: IncomingUpdate): Promise<HandlerResult>;
}

export interface HandlerRegistryPort {
	register(command: string, webhook: string): void;
	unregister(command: string): void;
	getHandler(command: string): string | undefined;
	list(): Array<{ command: string; webhook: string }>;
}
