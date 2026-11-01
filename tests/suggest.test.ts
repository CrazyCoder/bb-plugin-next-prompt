import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationMessages } from "../suggest.ts";

const T = "thr_1";
const user = (id: string, text: string, threadId = T) => ({ kind: "conversation", role: "user", id, threadId, text });
const assistant = (id: string, text: string) => ({ kind: "conversation", role: "assistant", id, threadId: T, text });

test("reads user and assistant text in order", () => {
	assert.deepEqual(conversationMessages([user("u1", "fix the login bug"), assistant("a1", "Fixed it.")], T), [
		{ role: "user", text: "fix the login bug" },
		{ role: "assistant", text: "Fixed it." },
	]);
});

test("reads no tool or command rows and no rows of other threads", () => {
	const messages = conversationMessages(
		[
			user("u1", "do it"),
			{ kind: "work", workKind: "command", command: "rm -rf secret", output: "TOKEN=abc" },
			{ kind: "group", children: [user("x", "child thread text", "thr_child")] },
			assistant("a1", "Done."),
		],
		T,
	);
	assert.deepEqual(messages, [
		{ role: "user", text: "do it" },
		{ role: "assistant", text: "Done." },
	]);
});

test("reads only user and assistant roles", () => {
	const messages = conversationMessages(
		[user("u1", "do it"), { kind: "conversation", role: "system", id: "s1", threadId: T, text: "Context compacted" }],
		T,
	);
	assert.deepEqual(messages, [{ role: "user", text: "do it" }]);
});

test("reads nested rows of the same thread", () => {
	assert.deepEqual(conversationMessages([{ kind: "group", children: [user("u1", "hi"), assistant("a1", "hello")] }], T), [
		{ role: "user", text: "hi" },
		{ role: "assistant", text: "hello" },
	]);
});

test("a row with no text string reads as empty", () => {
	assert.deepEqual(conversationMessages([{ kind: "conversation", role: "user", threadId: T }], T), [{ role: "user", text: "" }]);
});
