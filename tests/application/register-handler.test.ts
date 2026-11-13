import { describe, it, expect } from "vitest";
import { RegisterHandlerUseCase } from "../../src/application/register-handler.ts";
import { createMockHandlerRegistry } from "../test/helpers.ts";

describe("RegisterHandlerUseCase", () => {
	it("registers a handler via the registry", () => {
		const registry = createMockHandlerRegistry();
		const useCase = new RegisterHandlerUseCase(registry);

		useCase.execute("/test", "https://example.com/hook");

		expect(registry.register).toHaveBeenCalledWith(
			"/test",
			"https://example.com/hook",
		);
	});

	it("lists registered handlers", () => {
		const registry = createMockHandlerRegistry();
		registry.register("/a", "http://a.com");
		registry.register("/b", "http://b.com");
		const useCase = new RegisterHandlerUseCase(registry);

		const list = useCase.list();

		expect(list).toEqual([
			{ command: "/a", webhook: "http://a.com" },
			{ command: "/b", webhook: "http://b.com" },
		]);
	});
});
