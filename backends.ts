// Lean model calls. Each takes the system prompt and transcript and resolves
// to the raw reply text; filtering happens in suggest.ts. Providers other than
// Claude Code and Codex run as hidden bb worker threads in server.ts.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A choice from bb's provider/model picker. */
export interface ModelSelection {
	providerId: string;
	model: string;
	reasoningLevel: string;
	serviceTier?: string;
}

/** Used until a model is picked; bb's own default model is too heavy to run after every turn. */
export const DEFAULT_SELECTION: ModelSelection = {
	providerId: "claude-code",
	model: "claude-sonnet-5-5",
	reasoningLevel: "low",
};

export const API_FORMATS = ["off", "anthropic", "openai"] as const;
export type ApiFormat = (typeof API_FORMATS)[number];

export interface ApiConfig {
	format: Exclude<ApiFormat, "off">;
	baseUrl: string;
	apiKey: string | undefined;
	model: string;
}

export interface CompletionRequest {
	system: string;
	prompt: string;
	signal: AbortSignal;
}

const MAX_OUTPUT_CHARS = 1_000_000;
const CLAUDE_EFFORTS = new Set(["medium", "high", "xhigh", "max"]);
const CODEX_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);

function run(
	command: string,
	args: string[],
	stdin: string,
	cwd: string,
	signal: AbortSignal,
	env: Record<string, string> = {},
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			signal,
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 4_000) stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve(stdout);
			else reject(new Error(`${command} exited ${code}: ${stderr.trim() || stdout.trim().slice(0, 500)}`));
		});
		child.stdin.on("error", () => {});
		child.stdin.end(stdin);
	});
}

/**
 * One-shot `claude -p` with no tools, MCP servers, settings, skills or session
 * file. At low reasoning thinking is off: with it Haiku spent 700-1800 output
 * tokens and 8-20 s on a four-word answer, and Sonnet answered the same with
 * or without it. Higher levels pass --effort and leave thinking on.
 */
export async function completeWithClaude(
	claudePath: string,
	selection: ModelSelection,
	request: CompletionRequest,
): Promise<string> {
	const thinking = CLAUDE_EFFORTS.has(selection.reasoningLevel);
	const args = [
		"-p",
		"--model", selection.model,
		...(thinking ? ["--effort", selection.reasoningLevel] : []),
		"--tools", "",
		"--strict-mcp-config",
		"--setting-sources", "",
		"--disable-slash-commands",
		"--no-session-persistence",
		"--system-prompt", request.system,
		"--output-format", "json",
	];
	const stdout = await run(claudePath, args, request.prompt, tmpdir(), request.signal, thinking ? {} : { MAX_THINKING_TOKENS: "0" });
	const result = JSON.parse(stdout) as { result?: unknown; is_error?: unknown };
	if (result.is_error === true || typeof result.result !== "string") {
		throw new Error(`claude: ${String(result.result ?? "no result")}`);
	}
	return result.result;
}

/** One-shot `codex exec` in an empty directory, ignoring user config and rules. */
export async function completeWithCodex(
	codexPath: string,
	selection: ModelSelection,
	request: CompletionRequest,
): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "bb-next-prompt-"));
	try {
		const outFile = join(dir, "last-message.txt");
		const effort = CODEX_EFFORTS.has(selection.reasoningLevel) ? selection.reasoningLevel : "low";
		const args = [
			"exec",
			"--skip-git-repo-check",
			"--ephemeral",
			"--ignore-user-config",
			"--ignore-rules",
			"--sandbox", "read-only",
			"--color", "never",
			"-c", `model_reasoning_effort=${effort}`,
			"--output-last-message", outFile,
			"--model", selection.model,
			"-",
		];
		await run(codexPath, args, `${request.system}\n\n---\n\n${request.prompt}`, dir, request.signal);
		return await readFile(outFile, "utf8");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<unknown> {
	const response = await fetch(url, {
		method: "POST",
		signal,
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`${url} answered ${response.status}: ${text.slice(0, 500)}`);
	return JSON.parse(text);
}

export async function completeWithApi(config: ApiConfig, request: CompletionRequest): Promise<string> {
	if (!config.model) throw new Error("Set the API model");
	if (config.format === "anthropic") {
		const base = (config.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
		const body = (await postJson(
			`${base}/v1/messages`,
			{ "anthropic-version": "2023-06-01", ...(config.apiKey ? { "x-api-key": config.apiKey } : {}) },
			{
				model: config.model,
				max_tokens: 100,
				system: request.system,
				messages: [{ role: "user", content: request.prompt }],
			},
			request.signal,
		)) as { content?: Array<{ type?: string; text?: string }> };
		return (body.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
	}
	if (!config.baseUrl) throw new Error("Set the API base URL for the openai format");
	const body = (await postJson(
		`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`,
		config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
		{
			model: config.model,
			max_tokens: 100,
			messages: [
				{ role: "system", content: request.system },
				{ role: "user", content: request.prompt },
			],
		},
		request.signal,
	)) as { choices?: Array<{ message?: { content?: string } }> };
	return body.choices?.[0]?.message?.content ?? "";
}
