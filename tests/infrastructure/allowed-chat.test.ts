import { describe, it, expect } from "vitest";
import { isAllowedChat } from "../../src/infrastructure/allowed-chat.ts";

describe("isAllowedChat", () => {
	it("denies every chat when the list is empty (closed by default)", () => {
		expect(isAllowedChat(42, [])).toBe(false);
		expect(isAllowedChat(undefined, [])).toBe(false);
	});

	it("denies a chat that is not in the list", () => {
		expect(isAllowedChat(99, [100, 200])).toBe(false);
	});

	it("allows a chat that is in the list", () => {
		expect(isAllowedChat(200, [100, 200])).toBe(true);
	});

	it("denies an update without chat id", () => {
		expect(isAllowedChat(undefined, [100, 200])).toBe(false);
	});
});
