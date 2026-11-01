// The plugin's default model route as an eval backend for next-prompt-core:
//   node ../next-prompt-core/scripts/eval.ts --complete ./backend.ts --model claude-sonnet-5-5
import { completeWithClaude, DEFAULT_SELECTION } from "./backends.ts";

const TIMEOUT_MS = 120_000;

export function complete(request: { model: string; effort: string; system: string; prompt: string }): Promise<string> {
	return completeWithClaude(
		"claude",
		{ providerId: DEFAULT_SELECTION.providerId, model: request.model, reasoningLevel: request.effort },
		{ system: request.system, prompt: request.prompt, signal: AbortSignal.timeout(TIMEOUT_MS) },
	);
}
