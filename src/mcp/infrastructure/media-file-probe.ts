import { statSync } from "node:fs";
import type { MediaFileProbe } from "../domain/media-file-probe.ts";

/** Existe y es un fichero regular; un directorio no vale como foto. */
export function createMediaFileProbe(): MediaFileProbe {
	return {
		exists(filePath: string): boolean {
			try {
				return statSync(filePath).isFile();
			} catch {
				return false;
			}
		},
	};
}
