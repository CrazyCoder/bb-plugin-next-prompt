// Next Prompt backend: after a visible thread goes idle, ask a model for the
// instruction the user is most likely to type next, and hold it for the composer
// in app.tsx. Suggestions are display-only: nothing is written
// to the thread or the agent's context.
import { createHash } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
	API_FORMATS,
	DEFAULT_SELECTION,
	completeWithApi,
	completeWithClaude,
	completeWithCodex,
	type ApiFormat,
	type CompletionRequest,
	type ModelSelection,
} from "./backends.ts";
import { SUGGESTION_CHANGED } from "./shared.ts";
import { SYSTEM_PROMPT, buildSuggestionPrompt, normalizeSuggestion } from "./suggest.ts";

const suggestionSchema = z.object({
	threadId: z.string(),
	text: z.string(),
	createdAt: z.string(),
});
export type Suggestion = z.infer<typeof suggestionSchema>;

const modelSelectionSchema = z.object({
	providerId: z.string().min(1).max(200),
	model: z.string().min(1).max(200),
	reasoningLevel: z.string().min(1).max(50),
	serviceTier: z.string().min(1).max(50).optional(),
});

export const rpcContract = defineRpcContract({
	model_get: {
		input: z.object({}),
		output: z.object({ selection: modelSelectionSchema, configured: z.boolean() }),
	},
	model_set: {
		input: modelSelectionSchema,
		output: z.object({ selection: modelSelectionSchema }),
	},
	suggestion_get: {
		input: z.object({ threadId: z.string().min(1).max(200) }),
		output: z.object({ suggestion: suggestionSchema.nullable() }),
	},
	suggestion_dismiss: {
		input: z.object({ threadId: z.string().min(1).max(200) }),
		output: z.object({ dismissed: z.boolean() }),
	},
});


type SpawnArgs = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];

type Outcome = { threadId: string; result: string; at: string };

/**
 * What the plugin last concluded for a thread's conversation, kept in kv so a
 * reload or restart neither repeats the request nor brings back a dismissed
 * suggestion. The fingerprint covers the prompt, the model route and the
 * transcript; any change to them makes the record stale.
 */
const storedSchema = z.object({
	fingerprint: z.string(),
	status: z.enum(["ready", "dismissed", "silent"]),
	text: z.string().optional(),
	createdAt: z.string(),
});
type Stored = z.infer<typeof storedSchema>;
type Held = Suggestion & { fingerprint: string };

const MAX_TIMELINE_PAGES = 5;
const MODEL_SELECTION_KEY = "model-selection";
const STORED_PREFIX = "suggestion:";
/** A child in any of these is queued, starting or running, so its parent is not done. */
const CHILD_WORKING_STATUSES = ["pending", "starting", "active"] as const;
/** Records of threads deleted while the plugin was not loaded are dropped after this. */
const STORED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Least to most permissive; a worker gets the first one its provider supports. */
const WORKER_PERMISSION_MODES = ["accept-edits", "auto", "full"] as const;

type ThreadEventTarget = {
	visibility?: string;
	originPluginId?: string | null;
	parentThreadId?: string | null;
};

export default async function plugin(bb: BbPluginApi) {
	const settings = bb.settings.define({
		enabled: {
			type: "boolean",
			label: "Suggest the next prompt automatically",
			description: "After each finished turn in a visible thread, generate one suggestion.",
			default: true,
		},
		display: {
			type: "select",
			label: "Show the suggestion as",
			description: "banner: a line above the composer. ghost: grey text inside the empty composer.",
			options: ["banner", "ghost"],
			default: "banner",
		},
		apiFormat: {
			type: "select",
			label: "HTTP API override",
			description:
				"off uses the model chosen under Suggestion model. anthropic or openai sends every request to the API set below instead.",
			options: [...API_FORMATS],
			default: "off",
		},
		apiBaseUrl: {
			type: "string",
			label: "API base URL",
			description:
				"anthropic: the host, /v1/messages is appended (empty = https://api.anthropic.com). openai: the /v1 root, /chat/completions is appended.",
			default: "",
		},
		apiModel: { type: "string", label: "API model", default: "" },
		apiKey: {
			type: "string",
			label: "API key",
			description: "Sent as x-api-key (anthropic) or a Bearer token (openai).",
			secret: true,
		},
		claudePath: { type: "string", label: "claude executable", default: "claude" },
		codexPath: { type: "string", label: "codex executable", default: "codex" },
		timeoutSeconds: {
			type: "number",
			label: "Timeout (seconds)",
			description: "Per request. Worker threads for providers other than Claude Code and Codex need the most.",
			default: 60,
			experimental_schema: z.number().int().min(5).max(300),
		},
		maxContextChars: {
			type: "number",
			label: "Transcript budget (characters)",
			description: "Recent user and assistant text sent with each request. Tool calls and output are never sent.",
			default: 10_000,
			experimental_schema: z.number().int().min(1_000).max(100_000),
		},
	});
	let values = await settings.get();
	settings.onChange((next) => {
		values = next;
	});

	const storedSelection = modelSelectionSchema.safeParse(await bb.storage.kv.get(MODEL_SELECTION_KEY));
	let selection: ModelSelection | null = storedSelection.success ? storedSelection.data : null;

	/** One line naming what answers the next request, for status output. */
	const describeRoute = (): string => {
		const format = values.apiFormat as ApiFormat;
		if (format !== "off") return `${format} API ${values.apiModel || "(no model)"} at ${values.apiBaseUrl || "default URL"}`;
		const active = selection ?? DEFAULT_SELECTION;
		const via = active.providerId === "claude-code" ? "claude -p" : active.providerId === "codex" ? "codex exec" : "hidden worker thread";
		return `${active.providerId}/${active.model} @ ${active.reasoningLevel} via ${via}${selection ? "" : " (default)"}`;
	};

	/** Hidden worker thread on any bb provider, archived and stopped after each attempt. */
	const completeWithWorker = async (
		sourceThreadId: string,
		execution: ModelSelection,
		request: CompletionRequest,
	): Promise<string> => {
		const source = await bb.sdk.threads.get({ threadId: sourceThreadId, signal: request.signal });
		const options = await bb.sdk.system.executionOptions({ signal: request.signal });
		const supported: readonly string[] =
			options.providers.find((provider) => provider.id === execution.providerId)?.capabilities.permissionModes ?? [];
		const permissionMode = WORKER_PERMISSION_MODES.find((mode) => supported.includes(mode)) ?? "accept-edits";
		const worker = await bb.sdk.threads.spawn({
			projectId: source.projectId,
			environment: source.environmentId
				? { type: "reuse", environmentId: source.environmentId }
				: { type: "project-default" },
			providerId: execution.providerId,
			model: execution.model,
			reasoningLevel: execution.reasoningLevel as SpawnArgs["reasoningLevel"],
			...(execution.serviceTier ? { serviceTier: execution.serviceTier as SpawnArgs["serviceTier"] } : {}),
			permissionMode,
			title: "Next prompt worker",
			visibility: "hidden",
			prompt: `${request.system}\n\nDo not use tools. Reply with the suggestion only.\n\n---\n\n${request.prompt}`,
		});
		try {
			// Rejects as soon as the worker enters error, so a failed start does not run out the timeout.
			await bb.sdk.threads.wait({
				threadId: worker.id,
				status: "idle",
				timeoutMs: values.timeoutSeconds * 1000,
				signal: request.signal,
			});
			return (await bb.sdk.threads.output({ threadId: worker.id, signal: request.signal })).output ?? "";
		} finally {
			await bb.sdk.threads.archive({ threadId: worker.id }).catch(() => {});
			await bb.sdk.threads.stop({ threadId: worker.id }).catch(() => {});
		}
	};

	const complete = (threadId: string, request: CompletionRequest): Promise<string> => {
		const format = values.apiFormat as ApiFormat;
		if (format !== "off") {
			return completeWithApi(
				{ format, baseUrl: values.apiBaseUrl.trim(), apiKey: values.apiKey, model: values.apiModel.trim() },
				request,
			);
		}
		const active = selection ?? DEFAULT_SELECTION;
		if (active.providerId === "claude-code") return completeWithClaude(values.claudePath.trim() || "claude", active, request);
		if (active.providerId === "codex") return completeWithCodex(values.codexPath.trim() || "codex", active, request);
		return completeWithWorker(threadId, active, request);
	};

	const suggestions = new Map<string, Held>();
	const inFlight = new Map<string, AbortController>();
	/** Threads whose stored record this load has already checked against the conversation. */
	const restored = new Set<string>();
	/** One restore check per thread, shared by every client asking at once. */
	const restoring = new Map<string, Promise<Held | null>>();
	/** Bumped when a thread moves on, so work begun before that discards its result. */
	const epochs = new Map<string, number>();
	const epoch = (threadId: string) => epochs.get(threadId) ?? 0;
	const outcomes: Outcome[] = [];
	let disposed = false;

	// Covers what decides the reply, not normalizeSuggestion's filter: a looser
	// filter in a later release leaves "silent" records until the thread moves on.
	const fingerprint = (prompt: string) =>
		createHash("sha256").update(SYSTEM_PROMPT).update("\0").update(describeRoute()).update("\0").update(prompt).digest("hex");

	const readStored = async (threadId: string): Promise<Stored | undefined> => {
		const key = `${STORED_PREFIX}${threadId}`;
		const raw = await bb.storage.kv.get(key);
		if (raw === undefined) return undefined;
		const parsed = storedSchema.safeParse(raw);
		if (parsed.success) return parsed.data;
		await bb.storage.kv.delete(key);
		return undefined;
	};
	const writeStored = (threadId: string, record: Omit<Stored, "createdAt">) =>
		bb.storage.kv.set(`${STORED_PREFIX}${threadId}`, { ...record, createdAt: new Date().toISOString() });
	const forgetStored = (threadId: string) => bb.storage.kv.delete(`${STORED_PREFIX}${threadId}`).catch(() => {});

	const toSuggestion = (held: Held): Suggestion => ({ threadId: held.threadId, text: held.text, createdAt: held.createdAt });

	const publish = (threadId: string) => {
		if (disposed) return;
		try {
			bb.realtime.publish(SUGGESTION_CHANGED, { threadId });
		} catch {
			// The host can invalidate handles while a request unwinds during dispose.
		}
	};

	const record = (threadId: string, result: string) => {
		outcomes.push({ threadId, result, at: new Date().toISOString() });
		if (outcomes.length > 20) outcomes.shift();
		if (!disposed) bb.log.info(`${threadId}: ${result}`);
	};

	const clear = (threadId: string) => {
		inFlight.get(threadId)?.abort();
		inFlight.delete(threadId);
		epochs.set(threadId, epoch(threadId) + 1);
		restored.add(threadId);
		void forgetStored(threadId);
		if (suggestions.delete(threadId)) publish(threadId);
	};

	const readPrompt = async (threadId: string, signal?: AbortSignal): Promise<string | undefined> => {
		const pages: unknown[][] = [];
		let before: { id: string; seq: number } | undefined;
		for (let page = 0; page < MAX_TIMELINE_PAGES; page += 1) {
			const response = await bb.sdk.threads.timeline({
				threadId,
				includeNestedRows: "true",
				...(before ? { beforeAnchorId: before.id, beforeAnchorSeq: String(before.seq) } : {}),
				signal,
			});
			pages.unshift(response.rows);
			const prompt = buildSuggestionPrompt(pages.flat(), threadId, values.maxContextChars);
			if (prompt && prompt.length >= values.maxContextChars) break;
			const cursor = response.timelinePage.olderCursor;
			if (!response.timelinePage.hasOlderRows || cursor === null) break;
			before = { id: cursor.anchorId, seq: cursor.anchorSeq };
		}
		return buildSuggestionPrompt(pages.flat(), threadId, values.maxContextChars);
	};

	/**
	 * Generate and store a suggestion; resolves to the stored text or a reason
	 * it was not stored. With `reuse`, a stored record for the same
	 * conversation answers instead of a new request.
	 */
	const generate = async (
		threadId: string,
		options: { reuse: boolean; signal?: AbortSignal },
	): Promise<{ text?: string; reason: string }> => {
		inFlight.get(threadId)?.abort();
		const controller = new AbortController();
		inFlight.set(threadId, controller);
		const outerSignal = options.signal;
		const signals = [controller.signal, AbortSignal.timeout(values.timeoutSeconds * 1000)];
		if (outerSignal) signals.push(outerSignal);
		const signal = AbortSignal.any(signals);
		try {
			const prompt = await readPrompt(threadId, signal);
			if (!prompt) return { reason: "no completed exchange" };
			const hash = fingerprint(prompt);
			restored.add(threadId);
			const stored = options.reuse ? await readStored(threadId) : undefined;
			if (inFlight.get(threadId) !== controller) return { reason: "superseded" };
			if (stored?.fingerprint === hash) {
				if (stored.status !== "ready" || !stored.text) return { reason: `unchanged: ${stored.status} earlier` };
				suggestions.set(threadId, { threadId, text: stored.text, createdAt: stored.createdAt, fingerprint: hash });
				publish(threadId);
				return { text: stored.text, reason: "shown" };
			}
			const raw = await complete(threadId, { system: SYSTEM_PROMPT, prompt, signal });
			if (inFlight.get(threadId) !== controller) return { reason: "superseded" };
			const text = normalizeSuggestion(raw);
			if (!text) {
				await writeStored(threadId, { fingerprint: hash, status: "silent" });
				return { reason: `filtered: ${JSON.stringify(raw.trim().slice(0, 120))}` };
			}
			const held: Held = { threadId, text, createdAt: new Date().toISOString(), fingerprint: hash };
			await writeStored(threadId, { fingerprint: hash, status: "ready", text });
			if (inFlight.get(threadId) !== controller) return { reason: "superseded" };
			suggestions.set(threadId, held);
			publish(threadId);
			return { text, reason: "shown" };
		} catch (error) {
			if (controller.signal.aborted || outerSignal?.aborted) return { reason: "cancelled" };
			if (signal.aborted) return { reason: "timed out" };
			return { reason: `failed: ${error instanceof Error ? error.message : String(error)}` };
		} finally {
			if (inFlight.get(threadId) === controller) inFlight.delete(threadId);
		}
	};

	// Child threads are driven by their parent agent, so a suggestion there
	// would cost a request nobody reads.
	const isTarget = (thread: ThreadEventTarget) =>
		thread.visibility !== "hidden" && !thread.parentThreadId && thread.originPluginId !== bb.pluginId;

	/**
	 * The thread's suggestion. After a reload the first call checks the stored
	 * record against the current conversation and shows it only when the
	 * fingerprint still matches.
	 */
	const current = (threadId: string): Promise<Held | null> => {
		const held = suggestions.get(threadId);
		if (held || restored.has(threadId)) return Promise.resolve(held ?? null);
		let pending = restoring.get(threadId);
		if (!pending) {
			pending = restore(threadId).finally(() => restoring.delete(threadId));
			restoring.set(threadId, pending);
		}
		return pending;
	};

	/** A failed check is not marked done, so the next read tries again. */
	const restore = async (threadId: string): Promise<Held | null> => {
		const start = epoch(threadId);
		const stored = await readStored(threadId);
		if (stored?.status !== "ready" || !stored.text) {
			restored.add(threadId);
			return null;
		}
		const thread = await bb.sdk.threads.get({ threadId });
		const prompt = thread.status === "idle" ? await readPrompt(threadId) : undefined;
		// The thread moved on during the check; clear() has dropped the record.
		if (epoch(threadId) !== start) return suggestions.get(threadId) ?? null;
		restored.add(threadId);
		if (!prompt || fingerprint(prompt) !== stored.fingerprint) {
			await forgetStored(threadId);
			return null;
		}
		if (suggestions.has(threadId) || inFlight.has(threadId)) return suggestions.get(threadId) ?? null;
		const restoredHeld: Held = { threadId, text: stored.text, createdAt: stored.createdAt, fingerprint: stored.fingerprint };
		suggestions.set(threadId, restoredHeld);
		return restoredHeld;
	};

	bb.events.on("thread.idle", async ({ thread }) => {
		if (!values.enabled || !isTarget(thread)) return;
		if (thread.queuedMessageCount > 0) {
			record(thread.id, "skipped: queued messages");
			return;
		}
		// A parent with children at work usually runs again when they report back.
		const start = epoch(thread.id);
		const counts = await Promise.all(
			CHILD_WORKING_STATUSES.map((status) =>
				bb.sdk.threads.count({ parentThreadId: thread.id, status }).catch(() => ({ total: 0 })),
			),
		);
		if (epoch(thread.id) !== start) return;
		if (counts.some((count) => count.total > 0)) {
			record(thread.id, "skipped: child threads running");
			return;
		}
		void generate(thread.id, { reuse: true }).then(({ text, reason }) => record(thread.id, text ? `shown: ${text}` : reason));
	});
	bb.events.on("thread.active", ({ thread }) => clear(thread.id));
	bb.events.on("thread.failed", ({ thread }) => clear(thread.id));
	bb.events.on("thread.archived", ({ thread }) => clear(thread.id));
	bb.events.on("thread.deleted", ({ thread }) => clear(thread.id));

	bb.rpc.register(rpcContract, {
		model_get: () => ({ selection: selection ?? DEFAULT_SELECTION, configured: selection !== null }),
		model_set: async (next) => {
			await bb.storage.kv.set(MODEL_SELECTION_KEY, next);
			selection = next;
			return { selection: next };
		},
		suggestion_get: async ({ threadId }) => {
			const held = await current(threadId);
			return { suggestion: held ? toSuggestion(held) : null };
		},
		suggestion_dismiss: async ({ threadId }) => {
			const held = suggestions.get(threadId);
			if (!held) return { dismissed: false };
			suggestions.delete(threadId);
			publish(threadId);
			await writeStored(threadId, { fingerprint: held.fingerprint, status: "dismissed" });
			return { dismissed: true };
		},
	});

	const usage = [
		"Usage:",
		"  bb next-prompt show [thread-id] [--json]      Print the current suggestion",
		"  bb next-prompt suggest [thread-id] [--json]   Generate a suggestion now",
		"  bb next-prompt context [thread-id]            Print the transcript a request would send",
		"  bb next-prompt status [--json]                Show the model route and recent outcomes",
		"  bb next-prompt model [<provider>/<model>[@<reasoning>] | reset]",
		"                                                Show, set, or clear the suggestion model",
	].join("\n");
	bb.cli.register({
		name: "next-prompt",
		summary: "Show or generate next-prompt suggestions for BB threads",
		commands: [
			{ name: "show", summary: "Print a thread's current suggestion", usage: "bb next-prompt show [thread-id] [--json]" },
			{ name: "suggest", summary: "Generate a suggestion for an idle thread now", usage: "bb next-prompt suggest [thread-id] [--json]" },
			{ name: "context", summary: "Print the transcript a suggestion request would send", usage: "bb next-prompt context [thread-id]" },
			{ name: "status", summary: "Show the model route and recent outcomes", usage: "bb next-prompt status [--json]" },
			{
				name: "model",
				summary: "Show, set, or clear the suggestion model (same as the settings picker)",
				usage: "bb next-prompt model [<provider>/<model>[@<reasoning>] | reset]",
			},
		],
		async run(argv, context) {
			const json = argv.includes("--json");
			const [command, ...args] = argv.filter((arg) => arg !== "--json");
			const threadId = args[0] ?? context.threadId;
			const needThread = { exitCode: 1, stderr: "Pass a thread id, or run this inside a bb thread." };
			switch (command) {
				case undefined:
				case "help":
				case "--help":
					return { exitCode: 0, stdout: usage };
				case "show": {
					if (!threadId) return needThread;
					const held = await current(threadId);
					const suggestion = held ? toSuggestion(held) : null;
					if (json) return { exitCode: 0, stdout: JSON.stringify(suggestion) };
					return suggestion
						? { exitCode: 0, stdout: suggestion.text }
						: { exitCode: 1, stderr: `No suggestion for ${threadId}.` };
				}
				case "suggest": {
					if (!threadId) return needThread;
					const thread = await bb.sdk.threads.get({ threadId, signal: context.signal });
					if (thread.status !== "idle") return { exitCode: 1, stderr: `Thread ${threadId} is ${thread.status}; wait until it is idle.` };
					const result = await generate(threadId, { reuse: false, signal: context.signal });
					record(threadId, result.text ? `shown: ${result.text}` : result.reason);
					if (json) return { exitCode: result.text ? 0 : 1, stdout: JSON.stringify(result) };
					return result.text
						? { exitCode: 0, stdout: result.text }
						: { exitCode: 1, stderr: `No suggestion (${result.reason}).` };
				}
				case "context": {
					if (!threadId) return needThread;
					const prompt = await readPrompt(threadId, context.signal);
					return prompt
						? { exitCode: 0, stdout: prompt }
						: { exitCode: 1, stderr: "The thread has no completed exchange yet." };
				}
				case "model": {
					const spec = args[0];
					if (spec === "reset") {
						await bb.storage.kv.delete(MODEL_SELECTION_KEY);
						selection = null;
					} else if (spec !== undefined) {
						const match = /^([^/@\s]+)\/([^@\s]+)(?:@(\S+))?$/.exec(spec);
						if (!match) return { exitCode: 1, stderr: "Expected <provider>/<model>[@<reasoning>], e.g. claude-code/claude-haiku-4-5-20251001@low." };
						const next = modelSelectionSchema.parse({ providerId: match[1], model: match[2], reasoningLevel: match[3] ?? "low" });
						await bb.storage.kv.set(MODEL_SELECTION_KEY, next);
						selection = next;
					}
					return { exitCode: 0, stdout: describeRoute() };
				}
				case "status": {
					const status = {
						enabled: values.enabled,
						model: describeRoute(),
						inFlight: [...inFlight.keys()],
						recent: outcomes.slice(-10),
					};
					if (json) return { exitCode: 0, stdout: JSON.stringify(status) };
					const lines = [
						`enabled: ${status.enabled}`,
						`model: ${status.model}`,
						`in flight: ${status.inFlight.length}`,
						"recent:",
						...(status.recent.length === 0
							? ["  (none)"]
							: status.recent.map((outcome) => `  ${outcome.at}  ${outcome.threadId}  ${outcome.result}`)),
					];
					return { exitCode: 0, stdout: lines.join("\n") };
				}
			}
			return { exitCode: 1, stderr: usage };
		},
	});

	void (async () => {
		const cutoff = Date.now() - STORED_MAX_AGE_MS;
		for (const key of await bb.storage.kv.list(STORED_PREFIX)) {
			const parsed = storedSchema.safeParse(await bb.storage.kv.get(key));
			if (!parsed.success || Date.parse(parsed.data.createdAt) < cutoff) await bb.storage.kv.delete(key);
		}
	})().catch((error: unknown) => {
		if (!disposed) bb.log.warn(`pruning stored suggestions failed: ${error instanceof Error ? error.message : String(error)}`);
	});

	bb.onDispose(() => {
		disposed = true;
		for (const controller of inFlight.values()) controller.abort();
		inFlight.clear();
		suggestions.clear();
	});

	bb.log.info("loaded");
}
