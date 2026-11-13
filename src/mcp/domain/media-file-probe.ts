/**
 * Comprobación de que un fichero local existe y es regular. Es un puerto para
 * que los casos de uso no toquen el sistema de ficheros.
 */
export interface MediaFileProbe {
	exists(filePath: string): boolean;
}
