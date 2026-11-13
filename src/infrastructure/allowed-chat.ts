// Portero único hacia Telegram: solo pasa el chat privado configurado. Sin lista
// configurada el gateway queda cerrado (no se acepta ningún update); la lista
// vacía NUNCA significa "todos".
export function isAllowedChat(
	chatId: number | undefined,
	allowedChats: number[],
): boolean {
	if (allowedChats.length === 0) return false;
	return chatId !== undefined && allowedChats.includes(chatId);
}
