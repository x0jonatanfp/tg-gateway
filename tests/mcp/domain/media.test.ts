import { describe, expect, it } from "vitest";
import {
	albumCountError,
	validateMediaPath,
} from "../../../src/mcp/domain/media.ts";

describe("rutas de medios", () => {
	it("acepta jpg, jpeg y png en cualquier caja", () => {
		for (const ext of [".jpg", ".jpeg", ".png", ".JPG", ".PNG"]) {
			expect(validateMediaPath(`/tmp/foto${ext}`, "photo")).toBeUndefined();
		}
	});

	it("rechaza extensiones no soportadas por cada endpoint", () => {
		expect(validateMediaPath("/tmp/foto.gif", "photo")).toContain(
			".jpg, .jpeg, .png",
		);
		expect(validateMediaPath("/tmp/clip.mov", "video")).toContain(".mp4");
		expect(validateMediaPath("/tmp/clip.MP4", "video")).toBeUndefined();
	});

	it("exige ruta absoluta porque el gateway lee desde su cwd", () => {
		expect(validateMediaPath("foto.jpg", "photo")).toContain("absoluta");
	});

	it("valida el número de fotos del álbum (2-10)", () => {
		expect(albumCountError(1)).toContain("entre 2 y 10");
		expect(albumCountError(11)).toContain("entre 2 y 10");
		expect(albumCountError(2)).toBeUndefined();
		expect(albumCountError(10)).toBeUndefined();
	});
});
