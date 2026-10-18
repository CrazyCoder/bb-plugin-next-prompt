import assert from "node:assert/strict";
import { test } from "node:test";
import { SYSTEM_PROMPT, buildSuggestionPrompt, normalizeSuggestion } from "../suggest.ts";

const T = "thr_1";
const user = (id: string, text: string, threadId = T) => ({ kind: "conversation", role: "user", id, threadId, text });
const assistant = (id: string, text: string) => ({ kind: "conversation", role: "assistant", id, threadId: T, text });

test("builds the original request and recent turns", () => {
	const prompt = buildSuggestionPrompt(
		[user("u1", "fix the login bug"), assistant("a1", "Fixed it."), user("u2", "run tests"), assistant("a2", "All pass.")],
		T,
		10_000,
	);
	assert.ok(prompt);
	assert.match(prompt, /^Original user request:\nfix the login bug\n\nRecent conversation:\nAssistant: Fixed it\.\n\nUser: run tests\n\nAssistant: All pass\.$/);
});

test("sends no tool or command rows and no rows of other threads", () => {
	const prompt = buildSuggestionPrompt(
		[
			user("u1", "do it"),
			{ kind: "work", workKind: "command", command: "rm -rf secret", output: "TOKEN=abc" },
			{ kind: "group", children: [user("x", "child thread text", "thr_child")] },
			assistant("a1", "Done."),
		],
		T,
		10_000,
	);
	assert.ok(prompt);
	assert.doesNotMatch(prompt, /secret|TOKEN|child thread/);
});

test("sends only user and assistant roles", () => {
	const prompt = buildSuggestionPrompt(
		[user("u1", "do it"), { kind: "conversation", role: "system", id: "s1", threadId: T, text: "Context compacted" }, assistant("a1", "Done.")],
		T,
		10_000,
	);
	assert.equal(prompt, "Original user request:\ndo it\n\nRecent conversation:\nAssistant: Done.");
});

test("reads nested rows of the same thread", () => {
	const prompt = buildSuggestionPrompt([{ kind: "group", children: [user("u1", "hi"), assistant("a1", "hello")] }], T, 10_000);
	assert.equal(prompt, "Original user request:\nhi\n\nRecent conversation:\nAssistant: hello");
});

test("no prompt until an assistant reply ends the timeline", () => {
	assert.equal(buildSuggestionPrompt([user("u1", "hi")], T, 10_000), undefined);
	assert.equal(buildSuggestionPrompt([assistant("a1", "hello")], T, 10_000), undefined);
	assert.equal(buildSuggestionPrompt([], T, 10_000), undefined);
});

test("keeps the newest turns within the budget", () => {
	const rows = [user("u0", "start")];
	for (let index = 1; index <= 50; index += 1) {
		rows.push(user(`u${index}`, `step ${index} ${"x".repeat(200)}`), assistant(`a${index}`, `ok ${index}`));
	}
	const prompt = buildSuggestionPrompt(rows, T, 2_000);
	assert.ok(prompt);
	assert.match(prompt, /ok 50$/);
	assert.doesNotMatch(prompt, /step 1 /);
	assert.ok(prompt.length < 2_000 + 300);
});

test("accepts short imperative suggestions and strips quotes and fences", () => {
	assert.equal(normalizeSuggestion("run the tests"), "run the tests");
	assert.equal(normalizeSuggestion('"commit this"'), "commit this");
	assert.equal(normalizeSuggestion("```\npush it\n```"), "push it");
	assert.equal(normalizeSuggestion("yes"), "yes");
	assert.equal(normalizeSuggestion("/review"), "/review");
});

test("reads the JSON reply", () => {
	assert.equal(normalizeSuggestion('{"suggestion": "run the tests"}'), "run the tests");
	assert.equal(normalizeSuggestion('```json\n{"suggestion": "да, удали"}\n```'), "да, удали");
	assert.equal(normalizeSuggestion('{"suggestion": null}'), undefined);
	assert.equal(normalizeSuggestion('{"suggestion": "Let me run the tests"}'), undefined);
	assert.equal(normalizeSuggestion('{"suggestion": ""}'), undefined);
	assert.equal(normalizeSuggestion('{"suggestion": 3}'), undefined);
	assert.equal(normalizeSuggestion('{"suggestion": "run'), undefined);
	assert.equal(normalizeSuggestion('{"other": "run the tests"}'), undefined);
});

test("the prompt asks for JSON and suggests no push", () => {
	assert.match(SYSTEM_PROMPT, /\{"suggestion": null\}/);
	assert.doesNotMatch(SYSTEM_PROMPT, /push it/i);
});

test("filters silence, assistant voice, evaluations and long output", () => {
	for (const output of [
		"",
		"none",
		"(silence)",
		"Let me run the tests",
		"looks good",
		"Run tests. Then deploy.",
		"Suggestion: run tests",
		"Not logged in · Please run /login",
		"word ".repeat(13),
		"maybe",
	]) {
		assert.equal(normalizeSuggestion(output), undefined, output);
	}
});
