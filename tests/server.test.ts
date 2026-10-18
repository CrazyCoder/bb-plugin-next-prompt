import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createFakePluginHost, makeThreadResponse, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const T = "thr_1";
const conversation = (reply: string) => [
	{ kind: "conversation", role: "user", id: "u1", threadId: T, text: "fix the bug, then run the tests" },
	{ kind: "conversation", role: "assistant", id: "a1", threadId: T, text: reply },
];

let rows: unknown[];
let children: Partial<Record<string, number>>;
let replies: string[];
let requests: number;
/** When set, timeline and count calls wait for it, so a test can act mid-request. */
let gate: Promise<void> | null;
const realFetch = globalThis.fetch;

function hold(): () => void {
	let release!: () => void;
	gate = new Promise((resolve) => {
		release = resolve;
	});
	return () => {
		gate = null;
		release();
	};
}

beforeEach(() => {
	rows = conversation("Fixed it. Should I run the tests?");
	children = {};
	gate = null;
	replies = [];
	requests = 0;
	globalThis.fetch = (async () => {
		requests += 1;
		const text = replies.shift() ?? '{"suggestion": null}';
		return new Response(JSON.stringify({ content: [{ type: "text", text }] }));
	}) as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

function host(): FakePluginHost {
	return createFakePluginHost({
		pluginId: "next-prompt",
		settings: { apiFormat: "anthropic", apiModel: "test-model" },
		sdk: {
			threads: {
				timeline: async () => {
					await gate;
					return { rows, timelinePage: { hasOlderRows: false, olderCursor: null } };
				},
				count: async (args) => {
					await gate;
					return { total: args?.parentThreadId === T && args.status ? (children[args.status] ?? 0) : 0 };
				},
				get: async () => makeThreadResponse({ id: T, status: "idle" }),
			},
		},
	});
}

async function settle(current: FakePluginHost) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const status = JSON.parse((await current.harness.runCli(["status", "--json"])).stdout) as { inFlight: string[] };
		if (status.inFlight.length === 0) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("generation did not settle");
}

async function idle(current: FakePluginHost) {
	await current.harness.emitThreadEvent("thread.idle", {
		thread: makeThreadResponse({ id: T, status: "idle", queuedMessageCount: 0 }),
		lastAssistantText: null,
	});
	await new Promise((resolve) => setTimeout(resolve, 5));
	await settle(current);
}

async function shown(current: FakePluginHost): Promise<string | null> {
	const result = (await current.harness.callRpc("suggestion_get", { threadId: T })) as { suggestion: { text: string } | null };
	return result.suggestion?.text ?? null;
}

async function lastOutcome(current: FakePluginHost): Promise<string | undefined> {
	const status = JSON.parse((await current.harness.runCli(["status", "--json"])).stdout) as { recent: Array<{ result: string }> };
	return status.recent.at(-1)?.result;
}

test("skips a parent whose child threads are still running", async () => {
	const current = host();
	await plugin(current.bb);
	for (const status of ["active", "starting", "pending"]) {
		children = { [status]: 1 };
		await idle(current);
		assert.equal(await lastOutcome(current), "skipped: child threads running", status);
	}
	assert.equal(requests, 0);
	children = { idle: 3, error: 1 };
	replies.push('{"suggestion": "run the tests"}');
	await idle(current);
	assert.equal(await shown(current), "run the tests");
});

test("a turn that starts while children are counted makes no request", async () => {
	const current = host();
	await plugin(current.bb);
	const release = hold();
	const event = current.harness.emitThreadEvent("thread.idle", {
		thread: makeThreadResponse({ id: T, status: "idle", queuedMessageCount: 0 }),
		lastAssistantText: null,
	});
	await new Promise((resolve) => setTimeout(resolve, 5));
	await current.harness.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: T, status: "active" }) });
	release();
	await event;
	await settle(current);
	assert.equal(requests, 0);
});

test("two clients asking at once after a reload both get the suggestion", async () => {
	const first = host();
	await plugin(first.bb);
	replies.push('{"suggestion": "run the tests"}');
	await idle(first);
	const second = await first.harness.reload(plugin);
	const [a, b] = await Promise.all([shown(second), shown(second)]);
	assert.deepEqual([a, b], ["run the tests", "run the tests"]);
});

test("a turn that starts during the restore check gets no stale suggestion", async () => {
	const first = host();
	await plugin(first.bb);
	replies.push('{"suggestion": "run the tests"}');
	await idle(first);
	const second = await first.harness.reload(plugin);
	const release = hold();
	const pending = shown(second);
	await new Promise((resolve) => setTimeout(resolve, 5));
	await second.harness.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: T, status: "active" }) });
	release();
	assert.equal(await pending, null);
	assert.equal(await shown(second), null);
});

test("a restore that fails is tried again", async () => {
	const first = host();
	await plugin(first.bb);
	replies.push('{"suggestion": "run the tests"}');
	await idle(first);
	const second = await first.harness.reload(plugin);
	second.harness.sdk.stub("threads.get", async () => {
		throw new Error("server busy");
	});
	await assert.rejects(shown(second));
	second.harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: T, status: "idle" }));
	assert.equal(await shown(second), "run the tests");
});

test("a suggestion survives a reload without a new request", async () => {
	const first = host();
	await plugin(first.bb);
	replies.push('{"suggestion": "run the tests"}');
	await idle(first);
	assert.equal(await shown(first), "run the tests");
	const second = await first.harness.reload(plugin);
	assert.equal(await shown(second), "run the tests");
	await idle(second);
	assert.equal(requests, 1);
	assert.equal(await shown(second), "run the tests");
});

test("a stored suggestion is not shown once the conversation changed", async () => {
	const first = host();
	await plugin(first.bb);
	replies.push('{"suggestion": "run the tests"}');
	await idle(first);
	const second = await first.harness.reload(plugin);
	rows = conversation("Fixed it and ran the tests: all pass.");
	assert.equal(await shown(second), null);
	replies.push('{"suggestion": "commit this"}');
	await idle(second);
	assert.equal(requests, 2);
	assert.equal(await shown(second), "commit this");
});

test("a dismissal is remembered for the same conversation", async () => {
	const first = host();
	await plugin(first.bb);
	replies.push('{"suggestion": "run the tests"}');
	await idle(first);
	await first.harness.callRpc("suggestion_dismiss", { threadId: T });
	const second = await first.harness.reload(plugin);
	assert.equal(await shown(second), null);
	await idle(second);
	assert.equal(requests, 1);
	assert.equal(await shown(second), null);
});

test("silence is remembered for the same conversation", async () => {
	const current = host();
	await plugin(current.bb);
	replies.push('{"suggestion": null}');
	await idle(current);
	await idle(current);
	assert.equal(requests, 1);
	assert.equal(await shown(current), null);
});

test("a thread that runs again forgets its stored suggestion", async () => {
	const first = host();
	await plugin(first.bb);
	replies.push('{"suggestion": "run the tests"}');
	await idle(first);
	await first.harness.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: T, status: "active" }) });
	const second = await first.harness.reload(plugin);
	assert.equal(await shown(second), null);
});

test("loading drops records older than 30 days and keeps recent ones", async () => {
	const first = host();
	await plugin(first.bb);
	const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
	await first.bb.storage.kv.set("suggestion:thr_old", { fingerprint: "x", status: "silent", createdAt: old });
	await first.bb.storage.kv.set("suggestion:thr_new", { fingerprint: "x", status: "silent", createdAt: new Date().toISOString() });
	await first.bb.storage.kv.set("suggestion:thr_bad", { status: "unknown" });
	const second = await first.harness.reload(plugin);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(await second.bb.storage.kv.list("suggestion:"), ["suggestion:thr_new"]);
});

test("suggest regenerates even when the conversation is unchanged", async () => {
	const current = host();
	await plugin(current.bb);
	replies.push('{"suggestion": null}');
	await idle(current);
	replies.push('{"suggestion": "run the tests"}');
	const result = await current.harness.runCli(["suggest", T]);
	assert.equal(result.stdout, "run the tests");
	assert.equal(requests, 2);
});
