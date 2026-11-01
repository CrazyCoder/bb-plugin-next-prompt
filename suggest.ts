// Reads bb timeline rows into next-prompt-core's Message list. No bb or Node
// APIs, so tests import it directly.
import type { Message } from "./vendor/next-prompt-core.ts";

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

/**
 * The user and assistant text of one thread. Tool calls, commands and their
 * output are other row kinds, so they never reach the model.
 */
export function conversationMessages(rows: readonly unknown[], threadId: string): Message[] {
	const messages: Message[] = [];
	for (const row of flattenRows(rows)) {
		if (row.kind !== "conversation" || row.threadId !== threadId) continue;
		if (row.role !== "user" && row.role !== "assistant") continue;
		messages.push({ role: row.role, text: typeof row.text === "string" ? row.text : "" });
	}
	return messages;
}
