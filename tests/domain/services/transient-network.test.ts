import { describe, it, expect } from "vitest";
import { isTransientNetworkError } from "../../../src/domain/services/transient-network.ts";

describe("isTransientNetworkError", () => {
	it("returns true for TimeoutError", () => {
		const err = Object.assign(new Error("aborted"), { name: "TimeoutError" });
		expect(isTransientNetworkError(err)).toBe(true);
	});

	it("returns true for AbortError", () => {
		const err = Object.assign(new Error("aborted"), { name: "AbortError" });
		expect(isTransientNetworkError(err)).toBe(true);
	});

	it("returns true for TypeError fetch failed (undici wrapping)", () => {
		expect(isTransientNetworkError(new TypeError("fetch failed"))).toBe(true);
	});

	it("returns true when cause.code is a known transient errno", () => {
		const err = new TypeError("fetch failed", {
			cause: { code: "ECONNRESET" },
		});
		expect(isTransientNetworkError(err)).toBe(true);
	});

	it("returns true for UND_ERR_SOCKET from undici", () => {
		const err = new TypeError("fetch failed", {
			cause: { code: "UND_ERR_SOCKET" },
		});
		expect(isTransientNetworkError(err)).toBe(true);
	});

	it("returns false for plain non-network errors", () => {
		expect(isTransientNetworkError(new Error("plain not-network"))).toBe(false);
	});

	it("returns true for fetch-failed wrapping even when cause.code is not in the transient set", () => {
		// "fetch failed" es el marker genérico que pone undici; la heurística
		// del helper lo trata como transitorio siempre, independientemente del
		// cause.code. En la práctica undici no produce este mensaje para
		// EACCESS o errores no-transitorios, pero si lo hiciera, reintentarlo
		// no causa daño.
		const err = new TypeError("fetch failed", {
			cause: { code: "EACCES" },
		});
		expect(isTransientNetworkError(err)).toBe(true);
	});

	it("returns false for unknown JS errors without cause", () => {
		expect(isTransientNetworkError({ random: "object" })).toBe(false);
	});
});
