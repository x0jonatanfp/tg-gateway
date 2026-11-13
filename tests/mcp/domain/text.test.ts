import { describe, expect, it } from "vitest";
import { escapeHtml, prepareText } from "../../../src/mcp/domain/text.ts";

describe("texto", () => {
	it("escapa & < > y deja intactos los caracteres de Markdown", () => {
		expect(escapeHtml("a & b <c> *d* _e_ [f]")).toBe(
			"a &amp; b &lt;c&gt; *d* _e_ [f]",
		);
	});

	it("plain escapa el texto y envía HTML", () => {
		expect(prepareText("uno < dos & tres", "plain")).toEqual({
			text: "uno &lt; dos &amp; tres",
			parseMode: "HTML",
		});
	});

	it("html pasa el texto tal cual con parse_mode HTML", () => {
		expect(prepareText("<b>negrita</b>", "html")).toEqual({
			text: "<b>negrita</b>",
			parseMode: "HTML",
		});
	});

	it("markdown no escapa y usa Markdown", () => {
		expect(prepareText("*negrita*", "markdown")).toEqual({
			text: "*negrita*",
			parseMode: "Markdown",
		});
	});
});
