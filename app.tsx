// Next Prompt frontend: a one-line banner above a thread's composer showing
// the suggestion server.ts generated. Clicking it, or pressing Tab or Right
// Arrow in the empty composer, puts the text in the draft without sending it.
import { useCallback, useEffect, useRef, useState } from "react";
import {
	definePluginApp,
	experimental_ProviderModelPicker as ProviderModelPicker,
	useComposer,
	useRealtime,
	useRpc,
	type ExperimentalProviderModelPickerValue,
	type PluginComposerApi,
} from "@get-bb/plugin-sdk/app";
import { SUGGESTION_CHANGED } from "./shared";
import type { Suggestion, rpcContract } from "./server";

/** Delay before a suggestion reappears after the draft is cleared back to empty. */
const REARM_DELAY_MS = 1_500;

function useSuggestion(threadId: string) {
	const rpc = useRpc<typeof rpcContract>();
	// Keyed by thread so a composer that switches threads never shows the
	// previous thread's suggestion, even when its response arrives late.
	const [loaded, setLoaded] = useState<{ threadId: string; suggestion: Suggestion | null } | null>(null);
	const refetch = useCallback(() => {
		rpc.call("suggestion_get", { threadId }).then(
			(result) => setLoaded({ threadId, suggestion: result.suggestion }),
			() => setLoaded({ threadId, suggestion: null }),
		);
	}, [rpc, threadId]);
	useEffect(refetch, [refetch]);
	useRealtime(SUGGESTION_CHANGED, (payload) => {
		const changed = (payload as { threadId?: unknown } | null)?.threadId;
		if (changed === threadId) refetch();
	});
	const dismiss = useCallback(() => {
		setLoaded({ threadId, suggestion: null });
		void rpc.call("suggestion_dismiss", { threadId }).catch(() => {});
	}, [rpc, threadId]);
	const suggestion = loaded?.threadId === threadId ? loaded.suggestion : null;
	return { suggestion, dismiss };
}

/** False while the user has typed, and for a moment after clearing the draft again. */
function useArmed(isEmpty: boolean): boolean {
	const [armed, setArmed] = useState(isEmpty);
	const wasEmpty = useRef(isEmpty);
	useEffect(() => {
		if (!isEmpty) {
			wasEmpty.current = false;
			setArmed(false);
			return;
		}
		if (wasEmpty.current) {
			setArmed(true);
			return;
		}
		wasEmpty.current = true;
		const timer = setTimeout(() => setArmed(true), REARM_DELAY_MS);
		return () => clearTimeout(timer);
	}, [isEmpty]);
	return armed;
}

/** The composer's editable element: the nearest one sharing an ancestor with the banner. */
function findEditor(banner: HTMLElement): HTMLElement | null {
	for (let node = banner.parentElement; node; node = node.parentElement) {
		const editor = node.querySelector<HTMLElement>('[contenteditable="true"], textarea');
		if (editor && !banner.contains(editor)) return editor;
	}
	return null;
}

function SuggestionBanner({ threadId, composer }: { threadId: string; composer: PluginComposerApi }) {
	const { suggestion, dismiss } = useSuggestion(threadId);
	const armed = useArmed(composer.isEmpty);
	const rootRef = useRef<HTMLDivElement>(null);
	const visible = suggestion !== null && armed && composer.isEmpty && !composer.isRunning;

	const accept = useCallback(() => {
		if (!suggestion) return;
		composer.insert(suggestion.text, { at: "end" });
		composer.focus();
	}, [composer, suggestion]);

	useEffect(() => {
		if (!visible) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Tab" && event.key !== "ArrowRight") return;
			if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
			const root = rootRef.current;
			const editor = root ? findEditor(root) : null;
			if (!editor || !(event.target instanceof Node) || !editor.contains(event.target)) return;
			event.preventDefault();
			event.stopPropagation();
			accept();
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [visible, accept]);

	if (!visible) return null;
	return (
		<div ref={rootRef} className="group flex min-w-0 items-center gap-2 px-3 py-1 text-xs text-muted-foreground">
			<button
				type="button"
				className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-foreground"
				onClick={accept}
				title="Insert into the composer (Tab or →)"
			>
				<span aria-hidden>↳</span>
				<span className="shrink-0">next:</span>
				<span className="truncate italic">{suggestion.text}</span>
				<span className="shrink-0 opacity-60">Tab ↹</span>
			</button>
			<button
				type="button"
				className="shrink-0 opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-60"
				onClick={dismiss}
				aria-label="Dismiss suggestion"
			>
				×
			</button>
		</div>
	);
}

function NextPromptBanner() {
	const composer = useComposer();
	const { scope } = composer;
	if (scope.kind !== "thread") return null;
	return <SuggestionBanner threadId={scope.threadId} composer={composer} />;
}

type PickerSelection = { selection: ExperimentalProviderModelPickerValue; configured: boolean };

function describeExecution(providerId: string): string {
	if (providerId === "claude-code") return "Runs claude -p with no tools, MCP servers or settings. Low reasoning turns thinking off, the fastest choice.";
	if (providerId === "codex") return "Runs codex exec in an empty directory, ignoring your Codex config.";
	return "Runs as a hidden bb worker thread with this provider's full agent setup, so each suggestion is slower and larger.";
}

function ModelSettings() {
	const rpc = useRpc<typeof rpcContract>();
	const [current, setCurrent] = useState<PickerSelection | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		rpc.call("model_get", {}).then(
			(result) => setCurrent(result as PickerSelection),
			(cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
		);
	}, [rpc]);

	const onChange = useCallback(
		(next: ExperimentalProviderModelPickerValue) => {
			setCurrent({ selection: next, configured: true });
			setSaving(true);
			setError(null);
			rpc.call("model_set", {
				providerId: next.providerId,
				model: next.model,
				reasoningLevel: next.reasoningLevel,
				...(next.serviceTier ? { serviceTier: next.serviceTier } : {}),
			}).then(
				() => setSaving(false),
				(cause: unknown) => {
					setSaving(false);
					setError(cause instanceof Error ? cause.message : String(cause));
				},
			);
		},
		[rpc],
	);

	if (!current) {
		return error ? <p role="alert" className="text-sm text-destructive">{error}</p> : <p className="text-xs text-muted-foreground">Loading…</p>;
	}
	const { selection, configured } = current;
	return (
		<div className="space-y-2 text-sm">
			<ProviderModelPicker value={selection} onChange={onChange} align="start" className="w-full" disabled={saving} />
			<p className="text-xs text-muted-foreground">
				{configured ? "Saved choice" : "Default (no saved choice)"} · {selection.providerId}/{selection.model} · {selection.reasoningLevel} reasoning.{" "}
				{describeExecution(selection.providerId)}
			</p>
			{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
		</div>
	);
}

export default definePluginApp((app) => {
	app.slots.settingsSection({
		id: "model",
		title: "Suggestion model",
		description: "Pick the provider and model that write suggestions. With no saved choice, Claude Code's Sonnet 5.5 at low reasoning.",
		component: ModelSettings,
	});
	app.composer.customize({
		id: "next-prompt",
		scopes: ["thread"],
		banners: [{ id: "next-prompt", chrome: "bare", component: NextPromptBanner }],
	});
});
