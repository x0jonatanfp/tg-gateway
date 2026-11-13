import { extname } from "node:path";
import { MAX_ALBUM_PHOTOS, MIN_ALBUM_PHOTOS } from "./limits.ts";

export type MediaKind = "photo" | "video";

const PHOTO_EXTENSIONS = [".jpg", ".jpeg", ".png"] as const;
const VIDEO_EXTENSIONS = [".mp4"] as const;

/**
 * El gateway lee el fichero desde su propio directorio de trabajo, así que la
 * ruta tiene que ser absoluta. Además solo etiqueta bien ciertas extensiones:
 * `send-photo` distingue jpg/jpeg del resto y `send-video` asume MP4.
 */
export function validateMediaPath(
	filePath: string,
	kind: MediaKind,
): string | undefined {
	if (!filePath.startsWith("/")) {
		return `La ruta debe ser absoluta (el gateway lee el fichero desde su propio directorio): ${filePath}`;
	}
	const extension = extname(filePath).toLowerCase();
	const photoExtensions: readonly string[] = PHOTO_EXTENSIONS;
	const videoExtensions: readonly string[] = VIDEO_EXTENSIONS;
	if (kind === "photo" && !photoExtensions.includes(extension)) {
		return `send_photo solo admite ${PHOTO_EXTENSIONS.join(", ")}: ${filePath}`;
	}
	if (kind === "video" && !videoExtensions.includes(extension)) {
		return `send_video solo admite ${VIDEO_EXTENSIONS.join(", ")}: ${filePath}`;
	}
	return undefined;
}

export function albumCountError(count: number): string | undefined {
	if (count < MIN_ALBUM_PHOTOS || count > MAX_ALBUM_PHOTOS) {
		return `Un álbum necesita entre ${MIN_ALBUM_PHOTOS} y ${MAX_ALBUM_PHOTOS} fotos; han llegado ${count}.`;
	}
	return undefined;
}
