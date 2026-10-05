// Pure suggestion logic: transcript building, the model prompt, and output
// filtering. No bb or Node APIs, so tests import it directly.

const MAX_SUGGESTION_CHARS = 100;
const MAX_SUGGESTION_WORDS = 12;
const MAX_ORIGINAL_REQUEST_CHARS = 2_500;
const MAX_USER_TURN_CHARS = 2_500;
const MAX_ASSISTANT_TURN_CHARS = 6_000;

export const SYSTEM_PROMPT = `[SUGGESTION MODE: Suggest what the user might naturally type next into the coding assistant.]

FIRST: Look at the user's recent messages and original request.

Your job is to predict what THEY would type - not what you think they should do.

THE TEST: Would they think "I was just about to type that"?

EXAMPLES:
User asked "fix the bug and run tests", bug is fixed → "run the tests"
After code written → "try it out"
The assistant offers options → suggest the one the user would likely pick, based on conversation
The assistant asks to continue → "yes" or "go ahead"
Task complete, obvious follow-up → "commit this" or "push it"
After error or misunderstanding → silence (let them assess/correct)

Be specific: "run the tests" beats "continue".

NEVER SUGGEST:
- Evaluative ("looks good", "thanks")
- Questions ("what about...?")
- Assistant-voice ("Let me...", "I'll...", "Here's...")
- New ideas they didn't ask about
- Multiple sentences

Stay silent if the next step isn't obvious from what the user said.

Format: 2-12 words, match the user's style and language. Or nothing.

Reply with ONLY the suggestion, no quotes or explanation.`;

type Row = Record<string, unknown>;

function asRow(value: unknown): Row | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Row)
		: undefined;
}

function flattenRows(rows: readonly unknown[], out: Row[] = []): Row[] {
	for (const raw of rows) {
		const row = asRow(raw);
		if (!row) continue;
		out.push(row);
		if (Array.isArray(row.children)) flattenRows(row.children, out);
	}
	return out;
}

function truncateMiddle(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	const half = Math.floor((maxLength - 7) / 2);
	return `${value.slice(0, half)}\n[...]\n${value.slice(-half)}`;
}

/**
 * Build the model input from bb timeline rows of one thread. Only user and
 * assistant conversation text is sent — never tool calls, commands or their
 * output. Returns undefined when the thread has no completed exchange.
 */
export function buildSuggestionPrompt(
	rows: readonly unknown[],
	threadId: string,
	maxContextChars: number,
): string | undefined {
	const conversation: Array<{ role: "User" | "Assistant"; text: string }> = [];
	for (const row of flattenRows(rows)) {
		if (row.kind !== "conversation" || row.threadId !== threadId) continue;
		if (row.role !== "user" && row.role !== "assistant") continue;
		const text = typeof row.text === "string" ? row.text.trim() : "";
		if (!text) continue;
		conversation.push({
			role: row.role === "user" ? "User" : "Assistant",
			text,
		});
	}

	const firstUserIndex = conversation.findIndex((entry) => entry.role === "User");
	const firstUser = conversation[firstUserIndex];
	if (!firstUser || conversation.at(-1)?.role !== "Assistant") return undefined;

	const recent: string[] = [];
	let length = 0;
	for (let index = conversation.length - 1; index > firstUserIndex; index -= 1) {
		const entry = conversation[index];
		if (!entry) continue;
		const limit = entry.role === "Assistant" ? MAX_ASSISTANT_TURN_CHARS : MAX_USER_TURN_CHARS;
		const rendered = `${entry.role}: ${truncateMiddle(entry.text, limit)}`;
		if (recent.length > 0 && length + rendered.length > maxContextChars) break;
		recent.push(rendered);
		length += rendered.length;
	}
	recent.reverse();

	return `Original user request:\n${truncateMiddle(firstUser.text, MAX_ORIGINAL_REQUEST_CHARS)}\n\nRecent conversation:\n${recent.join("\n\n")}`;
}

const ALLOWED_SINGLE_WORDS = new Set([
	"yes", "yeah", "yep", "yea", "yup", "sure", "ok", "okay", "push", "commit",
	"deploy", "stop", "continue", "check", "exit", "quit", "no",
]);

export function shouldFilterSuggestion(suggestion: string): boolean {
	const lower = suggestion.toLowerCase();
	const wordCount = suggestion.split(/\s+/).length;
	return (
		lower === "done" ||
		lower === "none" ||
		lower === "none." ||
		lower === "n/a" ||
		lower === "nothing found" ||
		lower === "nothing found." ||
		lower.startsWith("nothing to suggest") ||
		lower.startsWith("no suggestion") ||
		/\bsilence is\b|\bstay(s|ing)? silent\b/.test(lower) ||
		/^\W*silence\W*$/.test(lower) ||
		/^\(.*\)$|^\[.*\]$/.test(suggestion) ||
		lower.startsWith("api error:") ||
		lower.startsWith("prompt is too long") ||
		lower.startsWith("request timed out") ||
		lower.startsWith("invalid api key") ||
		lower.startsWith("not logged in") ||
		/^\w+:\s/.test(suggestion) ||
		(wordCount < 2 && !suggestion.startsWith("/") && !ALLOWED_SINGLE_WORDS.has(lower)) ||
		wordCount > MAX_SUGGESTION_WORDS ||
		suggestion.length >= MAX_SUGGESTION_CHARS ||
		/[.!?]\s+[A-Z]/.test(suggestion) ||
		/[\n*]|\*\*/.test(suggestion) ||
		/thanks|thank you|looks good|sounds good|that works|that worked|that's all|nice|great|perfect|makes sense|awesome|excellent/.test(lower) ||
		/^(let me|i'll|i've|i'm|i can|i would|i think|i notice|here's|here is|here are|that's|this is|this will|you can|you should|you could|sure,|of course|certainly)/i.test(suggestion)
	);
}

/** Strip fences and quotes from raw model output; undefined means "show nothing". */
export function normalizeSuggestion(output: string): string | undefined {
	const suggestion = output
		.trim()
		.replace(/^```(?:text|markdown)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim()
		.replace(/^(["'`“])([\s\S]+)(["'`”])$/, "$2")
		.trim();
	if (!suggestion || shouldFilterSuggestion(suggestion)) return undefined;
	return suggestion;
}
