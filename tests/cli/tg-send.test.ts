import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// El helper tg-send.mjs vive en este repo y se despliega en dist/ porque lo
// usan crons y scripts externos. Estos tests vigilan su contrato de línea de
// comandos sin enviar nada a Telegram.
const sourceScript = new URL("../../scripts/tg-send.mjs", import.meta.url)
	.pathname;

interface RunOptions {
	env?: Record<string, string>;
	cwd?: string;
}

function run(
	scriptPath: string,
	args: string[],
	options: RunOptions = {},
): { code: number; stderr: string } {
	try {
		execFileSync(process.execPath, [scriptPath, ...args], {
			stdio: "pipe",
			encoding: "utf8",
			// Entorno explícito: si heredara el del test runner, el resultado
			// dependería de la máquina y no solo de lo que declara cada test.
			env: { PATH: process.env.PATH ?? "", ...options.env },
			cwd: options.cwd,
		});
		return { code: 0, stderr: "" };
	} catch (error) {
		const e = error as { status: number; stderr: string };
		return { code: e.status, stderr: e.stderr };
	}
}

/** Directorio temporal sin `.env`. */
function emptyDir(prefix = "tg-send-cwd-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** Fichero de entorno temporal con el contenido dado. */
function envFile(content: string): string {
	const file = join(mkdtempSync(join(tmpdir(), "tg-send-env-")), "env");
	writeFileSync(file, content);
	return file;
}

/** Instalación de mentira: `<install>/dist/tg-send.mjs` + `<install>/.env`. */
function install(options: { env?: string } = {}): {
	installDir: string;
	scriptPath: string;
} {
	const installDir = emptyDir("tg-send-install-");
	const dist = join(installDir, "dist");
	mkdirSync(dist);
	const scriptPath = join(dist, "tg-send.mjs");
	copyFileSync(sourceScript, scriptPath);
	if (options.env !== undefined) {
		writeFileSync(join(installDir, ".env"), options.env);
	}
	return { installDir, scriptPath };
}

// `--text ""` resuelve el chat y luego rechaza el texto vacío: sirve para
// comprobar la resolución sin red y sin enviar nada.
const PROBE = ["--text", "", "--url", "http://127.0.0.1:9"];

describe("tg-send.mjs", () => {
	it("sin argumentos muestra el uso y sale con 2", () => {
		const result = run(sourceScript, []);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--files");
	});

	// Invocado por un enlace simbólico, `process.argv[1]` es la ruta del enlace:
	// compararla tal cual con `import.meta.url` hacía que el script no arrancara
	// y saliera con 0 sin imprimir nada.
	it("se ejecuta también a través de un enlace simbólico", () => {
		const link = join(emptyDir("tg-send-link-"), "tg-send.mjs");
		symlinkSync(sourceScript, link);

		const result = run(link, []);

		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--files");
	});

	it("importarlo no ejecuta el CLI", async () => {
		// Si `main()` corriera, el process.exit(2) del usage se llevaría por
		// delante el proceso de test.
		const mod = await import("../../scripts/tg-send.mjs");
		expect(typeof mod.defaultEnvFileFor).toBe("function");
	});

	it("rechaza un álbum de una sola foto sin llamar al gateway", () => {
		const result = run(sourceScript, [
			"--files",
			"/no/existe.png",
			"--url",
			"http://127.0.0.1:9",
		]);
		expect(result.code).not.toBe(0);
	});

	describe("env file por defecto", () => {
		it("lee el .env junto a la instalación aunque el cwd no tenga ninguno", () => {
			const { scriptPath } = install({
				env: "TG_ALLOWED_CHATS=-1000000000001\n",
			});
			const result = run(scriptPath, PROBE, { cwd: emptyDir() });
			// El chat se resolvió: el fallo es el texto vacío, no la resolución.
			expect(result.stderr).toContain("El texto está vacío");
		});

		it("ignora un .env del directorio de trabajo", () => {
			const { scriptPath } = install(); // sin .env junto a la instalación
			const cwd = emptyDir();
			writeFileSync(join(cwd, ".env"), "TG_ALLOWED_CHATS=-1000000000001\n");

			const result = run(scriptPath, PROBE, { cwd });

			expect(result.code).toBe(1);
			expect(result.stderr).toContain("No se pudo resolver el chat privado");
		});

		it("TG_GATEWAY_ENV_FILE manda sobre el .env de la instalación", () => {
			const { scriptPath } = install({
				env: "TG_ALLOWED_CHATS=-1000000000001\n",
			});
			// Fichero sin TG_ALLOWED_CHATS: si mandara el de la instalación,
			// el chat se resolvería y el error sería el del texto vacío.
			const result = run(scriptPath, PROBE, {
				env: { TG_GATEWAY_ENV_FILE: envFile("# sin chats\n") },
				cwd: emptyDir(),
			});
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("No se pudo resolver el chat privado");
		});

		it("calcula la ruta desde el script, esté donde esté", async () => {
			const { defaultEnvFileFor } = await import("../../scripts/tg-send.mjs");
			expect(
				defaultEnvFileFor(new URL("file:///opt/tg-gateway/dist/tg-send.mjs")),
			).toBe("/opt/tg-gateway/.env");
			expect(
				defaultEnvFileFor(new URL("file:///opt/app/scripts/tg-send.mjs")),
			).toBe("/opt/app/.env");
		});
	});

	describe("fuentes de chat opcionales", () => {
		it("cae a TELEGRAM_CHAT_ID de TG_CHAT_ID_ENV_FILES", () => {
			const { scriptPath } = install();
			const result = run(scriptPath, PROBE, {
				env: {
					TG_GATEWAY_ENV_FILE: "/no/existe.env",
					TG_CHAT_ID_ENV_FILES: envFile("TELEGRAM_CHAT_ID=42\n"),
				},
				cwd: emptyDir(),
			});
			expect(result.stderr).toContain("El texto está vacío");
		});

		it("falla cerrado cuando no hay ninguna fuente de chat", () => {
			const { scriptPath } = install();
			const result = run(scriptPath, PROBE, {
				env: { TG_GATEWAY_ENV_FILE: "/no/existe.env" },
				cwd: emptyDir(),
			});
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("No se pudo resolver el chat privado");
		});
	});
});
