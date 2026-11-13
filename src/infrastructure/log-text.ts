const LOG_TEXT_MAX = 200;

export function truncateLogText(value: string | undefined): string | undefined {
	const configured = process.env.TG_LOG_TEXT_CHARS;
	const max = configured == null || configured === ""
		? LOG_TEXT_MAX
		: Number(configured);
	if (!Number.isFinite(max) || max <= 0 || value == null) return undefined;
	return value.slice(0, max);
}
