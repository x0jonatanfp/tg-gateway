import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../src/infrastructure/config.ts";

const OLD_ENV = process.env;

beforeEach(() => {
	process.env = { ...OLD_ENV };
});

afterEach(() => {
	process.env = OLD_ENV;
});

describe("loadConfig", () => {
	it("reads TG_BOT_TOKEN from env", () => {
		process.env.TG_BOT_TOKEN = "abc123";
		const cfg = loadConfig();
		expect(cfg.tgToken).toBe("abc123");
	});

	it("defaults TG_BOT_TOKEN to empty string", () => {
		delete process.env.TG_BOT_TOKEN;
		const cfg = loadConfig();
		expect(cfg.tgToken).toBe("");
	});

	it("parses TG_ALLOWED_CHATS as number array", () => {
		process.env.TG_ALLOWED_CHATS = "100,200,300";
		const cfg = loadConfig();
		expect(cfg.allowedChats).toEqual([100, 200, 300]);
	});

	it("returns empty array for missing chat var", () => {
		delete process.env.TG_ALLOWED_CHATS;
		const cfg = loadConfig();
		expect(cfg.allowedChats).toEqual([]);
	});

	it("filters NaN values from parsed lists", () => {
		process.env.TG_ALLOWED_CHATS = "100,abc,200";
		const cfg = loadConfig();
		expect(cfg.allowedChats).toEqual([100, 200]);
	});

	it("defaults pollTimeout to 30", () => {
		delete process.env.TG_POLL_TIMEOUT;
		const cfg = loadConfig();
		expect(cfg.pollTimeout).toBe(30);
	});

	it("reads TG_POLL_TIMEOUT", () => {
		process.env.TG_POLL_TIMEOUT = "60";
		const cfg = loadConfig();
		expect(cfg.pollTimeout).toBe(60);
	});

	it("defaults minIntervalMs to 1200", () => {
		delete process.env.TG_MIN_INTERVAL_MS;
		const cfg = loadConfig();
		expect(cfg.minIntervalMs).toBe(1200);
	});

	it("reads TG_MIN_INTERVAL_MS", () => {
		process.env.TG_MIN_INTERVAL_MS = "500";
		const cfg = loadConfig();
		expect(cfg.minIntervalMs).toBe(500);
	});

	it("defaults port to 4000", () => {
		delete process.env.PORT;
		const cfg = loadConfig();
		expect(cfg.port).toBe(4000);
	});

	it("reads PORT from env", () => {
		process.env.PORT = "3000";
		const cfg = loadConfig();
		expect(cfg.port).toBe(3000);
	});

	it("defaults forwardTimeoutMs to 10000", () => {
		delete process.env.TG_TIMEOUT_FORWARD_MS;
		const cfg = loadConfig();
		expect(cfg.forwardTimeoutMs).toBe(10000);
	});

	it("reads TG_TIMEOUT_FORWARD_MS", () => {
		process.env.TG_TIMEOUT_FORWARD_MS = "5000";
		const cfg = loadConfig();
		expect(cfg.forwardTimeoutMs).toBe(5000);
	});

	it("falls back to default when TG_TIMEOUT_FORWARD_MS is invalid", () => {
		process.env.TG_TIMEOUT_FORWARD_MS = "abc";
		const cfg = loadConfig();
		expect(cfg.forwardTimeoutMs).toBe(10000);
	});

	it("falls back to default when TG_TIMEOUT_FORWARD_MS is zero or negative", () => {
		process.env.TG_TIMEOUT_FORWARD_MS = "0";
		const cfg = loadConfig();
		expect(cfg.forwardTimeoutMs).toBe(10000);
	});

	it("handles empty TG_ALLOWED_CHATS", () => {
		process.env.TG_ALLOWED_CHATS = "";
		const cfg = loadConfig();
		expect(cfg.allowedChats).toEqual([]);
	});

	it("handles whitespace in comma-separated lists", () => {
		process.env.TG_ALLOWED_CHATS = " 100 , 200 ";
		const cfg = loadConfig();
		expect(cfg.allowedChats).toEqual([100, 200]);
	});

		describe("descargas eliminadas", () => {
			// La función de descargas ya no existe: si un .env viejo conserva estas
			// variables, se ignoran en silencio en vez de romper el arranque.
			it("ignora TG_DOWNLOAD_DIR, TG_POST_DOWNLOAD_SCRIPT y TG_MAX_CONCURRENT_DOWNLOADS", () => {
				process.env.TG_DOWNLOAD_DIR = "/opt/media/inbox";
				process.env.TG_POST_DOWNLOAD_SCRIPT = "/opt/tools/organize.sh";
				process.env.TG_MAX_CONCURRENT_DOWNLOADS = "5";

				const cfg = loadConfig() as unknown as Record<string, unknown>;

				expect(cfg.downloadDir).toBeUndefined();
				expect(cfg.postDownloadScript).toBeUndefined();
				expect(cfg.maxConcurrentDownloads).toBeUndefined();
			});
		});

		describe("forwardRetries", () => {
			beforeEach(() => {
				delete process.env.TG_FORWARD_RETRIES;
			});

			it("defaults to 0 (no retry, safe for non-idempotent webhooks)", () => {
				const cfg = loadConfig();
				expect(cfg.forwardRetries).toBe(0);
			});

			it("reads TG_FORWARD_RETRIES", () => {
				process.env.TG_FORWARD_RETRIES = "3";
				const cfg = loadConfig();
				expect(cfg.forwardRetries).toBe(3);
			});

			it("falls back to default on invalid value", () => {
				process.env.TG_FORWARD_RETRIES = "abc";
				const cfg = loadConfig();
				expect(cfg.forwardRetries).toBe(0);
			});

			it("falls back to default on zero or negative value", () => {
				process.env.TG_FORWARD_RETRIES = "-1";
				const cfg = loadConfig();
				expect(cfg.forwardRetries).toBe(0);
			});
		});

		describe("circuit breaker", () => {
			beforeEach(() => {
				delete process.env.TG_CIRCUIT_BREAKER_THRESHOLD;
				delete process.env.TG_CIRCUIT_BREAKER_COOLDOWN_MS;
			});

			it("defaults threshold to 5 and cooldown to 30000", () => {
				const cfg = loadConfig();
				expect(cfg.circuitBreakerThreshold).toBe(5);
				expect(cfg.circuitBreakerCooldownMs).toBe(30_000);
			});

			it("reads TG_CIRCUIT_BREAKER_THRESHOLD", () => {
				process.env.TG_CIRCUIT_BREAKER_THRESHOLD = "10";
				const cfg = loadConfig();
				expect(cfg.circuitBreakerThreshold).toBe(10);
			});

			it("reads TG_CIRCUIT_BREAKER_COOLDOWN_MS", () => {
				process.env.TG_CIRCUIT_BREAKER_COOLDOWN_MS = "15000";
				const cfg = loadConfig();
				expect(cfg.circuitBreakerCooldownMs).toBe(15_000);
			});

			it("falls back to defaults on invalid values", () => {
				process.env.TG_CIRCUIT_BREAKER_THRESHOLD = "abc";
				process.env.TG_CIRCUIT_BREAKER_COOLDOWN_MS = "-5";
				const cfg = loadConfig();
				expect(cfg.circuitBreakerThreshold).toBe(5);
				expect(cfg.circuitBreakerCooldownMs).toBe(30_000);
			});
		});

	describe("apiTimeouts", () => {
		beforeEach(() => {
			// Limpiar overrides entre tests
			for (const v of [
				"TG_TIMEOUT_SEND_MESSAGE_MS",
				"TG_TIMEOUT_SEND_PHOTO_MS",
				"TG_TIMEOUT_SEND_VIDEO_MS",
				"TG_TIMEOUT_EDIT_REPLY_MARKUP_MS",
				"TG_TIMEOUT_DELETE_MESSAGE_MS",
				"TG_TIMEOUT_ANSWER_CALLBACK_QUERY_MS",
				"TG_TIMEOUT_GET_ME_MS",
			]) delete process.env[v];
		});

		it("defaults to an empty map when no TG_TIMEOUT_*_MS env vars are set", () => {
			const cfg = loadConfig();
			expect(cfg.apiTimeouts).toEqual({});
		});

		it("reads TG_TIMEOUT_SEND_MESSAGE_MS as override", () => {
			process.env.TG_TIMEOUT_SEND_MESSAGE_MS = "7777";
			const cfg = loadConfig();
			expect(cfg.apiTimeouts.sendMessage).toBe(7777);
		});

		it("reads multiple TG_TIMEOUT_*_MS overrides simultaneously", () => {
			process.env.TG_TIMEOUT_SEND_MESSAGE_MS = "5000";
			process.env.TG_TIMEOUT_SEND_VIDEO_MS = "90000";
			process.env.TG_TIMEOUT_GET_ME_MS = "2000";
			const cfg = loadConfig();
			expect(cfg.apiTimeouts).toEqual({
				sendMessage: 5000,
				sendVideo: 90000,
				getMe: 2000,
			});
		});

		it("ignores invalid (NaN) timeout values", () => {
			process.env.TG_TIMEOUT_SEND_MESSAGE_MS = "not-a-number";
			const cfg = loadConfig();
			expect(cfg.apiTimeouts.sendMessage).toBeUndefined();
		});

		it("ignores zero or negative timeout values", () => {
			process.env.TG_TIMEOUT_SEND_MESSAGE_MS = "0";
			process.env.TG_TIMEOUT_SEND_PHOTO_MS = "-1";
			const cfg = loadConfig();
			expect(cfg.apiTimeouts.sendMessage).toBeUndefined();
			expect(cfg.apiTimeouts.sendPhoto).toBeUndefined();
		});

		it("ignores empty timeout values", () => {
			process.env.TG_TIMEOUT_SEND_MESSAGE_MS = "";
			const cfg = loadConfig();
			expect(cfg.apiTimeouts.sendMessage).toBeUndefined();
		});
	});
});
