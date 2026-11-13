export interface ToolOutcome {
	success: boolean;
	text: string;
}

export function fail(error: string): ToolOutcome {
	return { success: false, text: error };
}

export function ok(text: string): ToolOutcome {
	return { success: true, text };
}
