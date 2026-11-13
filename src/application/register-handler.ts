import type { HandlerRegistryPort } from "../domain/ports/handlers.ts";

export class RegisterHandlerUseCase {
	constructor(private handlerRegistry: HandlerRegistryPort) {}

	execute(command: string, webhook: string): void {
		this.handlerRegistry.register(command, webhook);
	}

	list() {
		return this.handlerRegistry.list();
	}
}
