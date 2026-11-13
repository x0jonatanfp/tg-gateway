import { describe, it, expect } from "vitest";
import { HandlerRegistry } from "../../src/infrastructure/handler-registry.ts";

describe("HandlerRegistry", () => {
	it("registers and retrieves a handler", () => {
		const registry = new HandlerRegistry();
		registry.register("/start", "https://hook.example.com/start");
		expect(registry.getHandler("/start")).toBe(
			"https://hook.example.com/start",
		);
	});

	it("returns undefined for unregistered command", () => {
		const registry = new HandlerRegistry();
		expect(registry.getHandler("/nothing")).toBeUndefined();
	});

	it("overwrites existing handler on re-register", () => {
		const registry = new HandlerRegistry();
		registry.register("/test", "https://old.com");
		registry.register("/test", "https://new.com");
		expect(registry.getHandler("/test")).toBe("https://new.com");
	});

	it("unregisters a handler", () => {
		const registry = new HandlerRegistry();
		registry.register("/a", "https://a.com");
		registry.unregister("/a");
		expect(registry.getHandler("/a")).toBeUndefined();
	});

	it("unregister does not throw for unknown command", () => {
		const registry = new HandlerRegistry();
		expect(() => registry.unregister("/unknown")).not.toThrow();
	});

	it("lists all registered handlers", () => {
		const registry = new HandlerRegistry();
		registry.register("/a", "https://a.com");
		registry.register("/b", "https://b.com");
		const list = registry.list();
		expect(list).toEqual([
			{ command: "/a", webhook: "https://a.com" },
			{ command: "/b", webhook: "https://b.com" },
		]);
	});

	it("returns empty list when no handlers registered", () => {
		const registry = new HandlerRegistry();
		expect(registry.list()).toEqual([]);
	});
});
