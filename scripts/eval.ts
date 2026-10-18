// Prompt evaluation: sends each labelled conversation in eval/cases.json to the
// suggestion model through `claude -p`, filters the reply the way the plugin
// does, and scores it. With --baseline <git-rev> the suggest.ts of that
// revision runs on the same cases, so a prompt change can be compared with the
// prompt it replaces. Each request bills like a real suggestion.
//
//   node scripts/eval.ts [--baseline <rev>] [--model <id>] [--reasoning <level>]
//                        [--repeats <n>] [--cases <file>] [--output <file>]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_SELECTION, completeWithClaude } from "../backends.ts";

interface Case {
	id: string;
	expected: "abstain" | "suggest";
	/** Regex (case-insensitive) a suggestion must match. */
	match?: string;
	/** Regex (case-insensitive) no suggestion may match, in either kind of case. */
	forbid?: string;
	conversation: Array<["user" | "assistant", string]>;
}

interface SuggestModule {
	SYSTEM_PROMPT: string;
	buildSuggestionPrompt(rows: readonly unknown[], threadId: string, maxContextChars: number): string | undefined;
	normalizeSuggestion(output: string): string | undefined;
}

interface Result {
	prompt: string;
	id: string;
	expected: Case["expected"];
	repeat: number;
	raw?: string;
	suggestion: string | null;
	pass: boolean;
	error?: string;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values: options } = parseArgs({
	options: {
		baseline: { type: "string" },
		model: { type: "string", default: DEFAULT_SELECTION.model },
		reasoning: { type: "string", default: DEFAULT_SELECTION.reasoningLevel },
		repeats: { type: "string", default: "1" },
		cases: { type: "string", default: join(root, "eval", "cases.json") },
		output: { type: "string" },
		concurrency: { type: "string", default: "4" },
	},
});

const THREAD = "thr_eval";
const cases = JSON.parse(readFileSync(options.cases, "utf8")) as Case[];
const repeats = Number(options.repeats);
const selection = { providerId: "claude-code", model: options.model, reasoningLevel: options.reasoning };

const prompts: Array<{ name: string; module: SuggestModule }> = [];
let scratch: string | undefined;
if (options.baseline) {
	const source = execFileSync("git", ["show", `${options.baseline}:suggest.ts`], { cwd: root, encoding: "utf8" });
	scratch = mkdtempSync(join(tmpdir(), "next-prompt-eval-"));
	const file = join(scratch, "suggest.ts");
	writeFileSync(file, source);
	prompts.push({ name: `baseline ${options.baseline}`, module: (await import(pathToFileURL(file).href)) as SuggestModule });
}
prompts.push({ name: "current", module: (await import(pathToFileURL(join(root, "suggest.ts")).href)) as SuggestModule });

function rows(conversation: Case["conversation"]) {
	return conversation.map(([role, text], index) => ({ kind: "conversation", role, id: `m${index}`, threadId: THREAD, text }));
}

function score(entry: Case, suggestion: string | null): boolean {
	if (suggestion !== null && entry.forbid && new RegExp(entry.forbid, "i").test(suggestion)) return false;
	if (entry.expected === "abstain") return suggestion === null;
	return suggestion !== null && (!entry.match || new RegExp(entry.match, "i").test(suggestion));
}

async function runOne(name: string, module: SuggestModule, entry: Case, repeat: number): Promise<Result> {
	const base = { prompt: name, id: entry.id, expected: entry.expected, repeat };
	const prompt = module.buildSuggestionPrompt(rows(entry.conversation), THREAD, 10_000);
	if (!prompt) return { ...base, suggestion: null, pass: false, error: "no prompt built" };
	try {
		const raw = await completeWithClaude("claude", selection, {
			system: module.SYSTEM_PROMPT,
			prompt,
			signal: AbortSignal.timeout(120_000),
		});
		const suggestion = module.normalizeSuggestion(raw) ?? null;
		return { ...base, raw: raw.trim(), suggestion, pass: score(entry, suggestion) };
	} catch (error) {
		return { ...base, suggestion: null, pass: false, error: error instanceof Error ? error.message : String(error) };
	}
}

// Alternate which prompt goes first between repeats, so neither always runs on a colder cache.
const jobs: Array<() => Promise<Result>> = [];
for (let repeat = 0; repeat < repeats; repeat += 1) {
	const order = repeat % 2 === 0 ? prompts : [...prompts].reverse();
	for (const entry of cases) for (const { name, module } of order) jobs.push(() => runOne(name, module, entry, repeat));
}
const results: Result[] = [];
let next = 0;
await Promise.all(
	Array.from({ length: Math.max(1, Number(options.concurrency)) }, async () => {
		while (next < jobs.length) {
			const job = jobs[next++];
			if (job) results.push(await job());
		}
	}),
);
if (scratch) rmSync(scratch, { recursive: true, force: true });

for (const entry of cases) {
	for (const { name } of prompts) {
		for (const result of results.filter((item) => item.id === entry.id && item.prompt === name).sort((a, b) => a.repeat - b.repeat)) {
			const shown = result.error ? `ERROR ${result.error.slice(0, 80)}` : result.suggestion === null ? `(none; raw ${JSON.stringify((result.raw ?? "").slice(0, 60))})` : result.suggestion;
			console.log(`${result.pass ? "pass" : "FAIL"}  ${entry.id.padEnd(30)} ${entry.expected.padEnd(8)} ${name.padEnd(18)} ${shown}`);
		}
	}
}
console.log("");
for (const { name } of prompts) {
	const own = results.filter((item) => item.prompt === name);
	const errors = own.filter((item) => item.error).length;
	const pass = own.filter((item) => item.pass).length;
	const byKind = (kind: Case["expected"]) => {
		const subset = own.filter((item) => item.expected === kind);
		return `${subset.filter((item) => item.pass).length}/${subset.length}`;
	};
	console.log(`${name}: ${pass}/${own.length} pass (abstain ${byKind("abstain")}, suggest ${byKind("suggest")})${errors ? `, ${errors} errors` : ""}`);
}
if (options.output) {
	writeFileSync(options.output, JSON.stringify({ model: selection, repeats, results }, null, "\t"));
	console.log(`wrote ${options.output}`);
}
process.exitCode = results.some((item) => item.error) ? 2 : 0;
