import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMediaFileProbe } from "../../../src/mcp/infrastructure/media-file-probe.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs.length = 0;
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "tg-mcp-media-"));
	dirs.push(dir);
	return dir;
}

describe("sondeo real de ficheros", () => {
	it("distingue fichero regular, directorio e inexistente", () => {
		const dir = tempDir();
		const file = join(dir, "foto.jpg");
		writeFileSync(file, "x");
		mkdirSync(join(dir, "carpeta"));
		const probe = createMediaFileProbe();
		expect(probe.exists(file)).toBe(true);
		expect(probe.exists(join(dir, "carpeta"))).toBe(false);
		expect(probe.exists(join(dir, "nada.jpg"))).toBe(false);
	});
});
