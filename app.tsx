// Next Prompt frontend: shows the suggestions server.ts generated, as numbered
// cards above a thread's composer, as grey text inside the empty editor, or
// both (the `display` setting). Pressing Tab or Right Arrow in the empty
// composer, or swiping right in it, puts the best one in the draft without
// sending it; a card does the same, or sends with `cardClick` set to send.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
	definePluginApp,
	experimental_Icon as Icon,
	experimental_ProviderModelPicker as ProviderModelPicker,
	useComposer,
	useRealtime,
	useRpc,
	useSettings,
	type ExperimentalProviderModelPickerValue,
	type PluginComposerApi,
} from "@get-bb/plugin-sdk/app";
import { CARD_GAP_PX, fitCount } from "./cards.ts";
import { paintGhost } from "./ghost.ts";
import { SUGGESTION_CHANGED } from "./shared.ts";
import { SwipeTracker } from "./swipe.ts";
import type { Suggestion, rpcContract } from "./server.ts";

/**
 * Delay before suggestions reappear after the draft is cleared back to empty.
 * Sending empties the draft too, just before the thread reports it is running.
 */
const REARM_DELAY_MS = 300;
const EXPANDED_KEY = "next-prompt:cards-expanded";
/** The cards row's padding and dismiss button. */
const ROW_CHROME_PX = 56;
/** bb's own icon button, as on its dismiss controls. */
const ICON_BUTTON =
	"flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground";
const EMPTY_DRAFT = { text: "", mentions: [] };

/**
 * Each thread's last prefill. `suggestionAt` keeps a cleared draft from filling
 * again; `owned` is the text still ours to remove, null once the user changes
 * the draft. Outlives the component, as the draft does when threads switch.
 */
const prefills = new Map<string, { suggestionAt: string; owned: string | null }>();

function useSuggestion(threadId: string) {
	const rpc = useRpc<typeof rpcContract>();
	// Keyed by thread so a composer that switches threads never shows the
	// previous thread's suggestion, even when its response arrives late.
	const [loaded, setLoaded] = useState<{ threadId: string; suggestion: Suggestion | null } | null>(null);
	const refetch = useCallback(() => {
		// A failed read says nothing about the suggestion, so what is loaded stays.
		rpc.call("suggestion_get", { threadId }).then(
			(result) => setLoaded({ threadId, suggestion: result.suggestion }),
			() => {},
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
	const isLoaded = loaded?.threadId === threadId;
	return { suggestion: isLoaded ? loaded.suggestion : null, isLoaded, dismiss };
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

/** Accept on a right swipe that starts in the editor. */
function useSwipeToAccept(rootRef: RefObject<HTMLElement | null>, active: boolean, accept: () => void) {
	// Read through a ref, so a re-render mid-gesture does not reattach the listeners and reset the tracker.
	const acceptRef = useRef(accept);
	acceptRef.current = accept;
	useEffect(() => {
		const root = rootRef.current;
		const editor = active && root ? findEditor(root) : null;
		if (!editor) return;
		const tracker = new SwipeTracker();
		const onStart = (event: TouchEvent) => {
			const touch = event.touches[0];
			if (event.touches.length !== 1 || !touch) return tracker.cancel();
			tracker.start(touch.clientX, touch.clientY, event.timeStamp, window.innerWidth);
		};
		const onMove = (event: TouchEvent) => {
			const touch = event.touches[0];
			if (event.touches.length !== 1 || !touch) return tracker.cancel();
			if (tracker.move(touch.clientX, touch.clientY, event.timeStamp) && event.cancelable) event.preventDefault();
		};
		const onEnd = (event: TouchEvent) => {
			const touch = event.changedTouches[0];
			if (event.touches.length !== 0 || !touch) return tracker.cancel();
			if (!tracker.end(touch.clientX, touch.clientY, event.timeStamp)) return;
			if (event.cancelable) event.preventDefault();
			acceptRef.current();
		};
		const onCancel = () => tracker.cancel();
		editor.addEventListener("touchstart", onStart, { capture: true, passive: true });
		editor.addEventListener("touchmove", onMove, { capture: true, passive: false });
		editor.addEventListener("touchend", onEnd, { capture: true, passive: false });
		editor.addEventListener("touchcancel", onCancel, true);
		return () => {
			editor.removeEventListener("touchstart", onStart, true);
			editor.removeEventListener("touchmove", onMove, true);
			editor.removeEventListener("touchend", onEnd, true);
			editor.removeEventListener("touchcancel", onCancel, true);
		};
	}, [rootRef, active]);
}

/** Whether the list shows every suggestion; remembered across sessions on this browser. */
function useExpanded(): [boolean, () => void] {
	const [expanded, setExpanded] = useState(() => {
		try {
			return localStorage.getItem(EXPANDED_KEY) === "true";
		} catch {
			return false;
		}
	});
	const toggle = useCallback(() => {
		setExpanded((current) => {
			try {
				localStorage.setItem(EXPANDED_KEY, String(!current));
			} catch {
				// Private browsing can refuse storage; the toggle still works for this page.
			}
			return !current;
		});
	}, []);
	return [expanded, toggle];
}

function CardLabel({ index, text, hint }: { index: number; text: string; hint: boolean }) {
	return (
		<>
			<span className="shrink-0 opacity-70">{index + 1}.</span>
			<span className="min-w-0 break-words">{text}</span>
			{hint ? <span className="shrink-0 opacity-60">Tab ↹</span> : null}
		</>
	);
}

function SuggestionCards({
	rootRef,
	texts,
	hint,
	title,
	onPick,
	onDismiss,
}: {
	rootRef: RefObject<HTMLElement | null>;
	texts: readonly string[];
	hint: boolean;
	title: string;
	onPick: (text: string) => void;
	onDismiss: () => void;
}) {
	const [expanded, toggleExpanded] = useExpanded();
	const [fit, setFit] = useState(1);
	const measureRef = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		const root = rootRef.current;
		const measure = measureRef.current;
		if (!root || !measure) return;
		const update = () => {
			const widths = Array.from(measure.children, (card) => (card as HTMLElement).offsetWidth);
			setFit(fitCount(widths, root.clientWidth - ROW_CHROME_PX));
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(root);
		return () => observer.disconnect();
	}, [rootRef, texts, hint]);

	const shown = expanded ? texts : texts.slice(0, fit);
	return (
		<div ref={rootRef as RefObject<HTMLDivElement>} className="relative flex min-w-0 items-start gap-2 px-3 py-1 text-xs">
			{/* Unclipped copies of the cards, so a card hidden from the row can still be measured. */}
			<div aria-hidden className="invisible absolute left-0 top-0 h-0 w-0 overflow-hidden">
				<div ref={measureRef} className="flex w-max whitespace-nowrap">
					{texts.map((text, index) => (
						<span key={text} className="inline-flex items-baseline gap-1 border px-2 py-0.5">
							<CardLabel index={index} text={text} hint={hint && index === 0} />
						</span>
					))}
				</div>
			</div>
			<div className="flex min-w-0 flex-1 flex-wrap" style={{ gap: CARD_GAP_PX }}>
				{shown.map((text, index) => (
					<button
						key={text}
						type="button"
						className={`inline-flex min-w-0 max-w-full items-baseline gap-1 rounded-md border px-2 py-0.5 text-left ${
							index === 0
								? "border-foreground bg-foreground text-background hover:bg-foreground/90"
								: "border-border text-foreground hover:bg-secondary"
						}`}
						onClick={() => onPick(text)}
						title={title}
					>
						<CardLabel index={index} text={text} hint={hint && index === 0} />
					</button>
				))}
			</div>
			{fit < texts.length ? (
				<button
					type="button"
					className={ICON_BUTTON}
					onClick={toggleExpanded}
					aria-expanded={expanded}
					aria-label={expanded ? "Show fewer suggestions" : "Show all suggestions"}
				>
					<Icon name={expanded ? "ChevronUp" : "ChevronDown"} className="size-3.5" aria-hidden="true" />
				</button>
			) : null}
			<button type="button" className={ICON_BUTTON} onClick={onDismiss} aria-label="Dismiss suggestions">
				<Icon name="X" className="size-3.5" aria-hidden="true" />
			</button>
		</div>
	);
}

function Suggestions({ threadId, composer }: { threadId: string; composer: PluginComposerApi }) {
	const { suggestion, isLoaded, dismiss } = useSuggestion(threadId);
	const settings = useSettings().values;
	const cards = settings?.display !== "ghost";
	const ghost = settings?.display === "ghost" || settings?.display === "both";
	const prefill = settings?.display === "both" && settings?.prefillBest === true;
	const clickSends = settings?.cardClick === "send";
	const armed = useArmed(composer.isEmpty);
	const rootRef = useRef<HTMLElement>(null);
	const best = suggestion?.texts[0] ?? null;
	const available = suggestion !== null && !composer.isRunning;
	/** The empty composer offers the best suggestion: grey text, Tab, → and swipe act on it. */
	const offered = available && armed && composer.isEmpty;
	const lastPrefill = prefills.get(threadId);
	/** The draft holds the unedited prefill, so the cards stay to pick another. */
	const prefilled =
		available && prefill && lastPrefill?.suggestionAt === suggestion.createdAt && lastPrefill.owned === composer.text;

	// Before the prefill effect: this commit's text predates an insert made there.
	const { text: draftText } = composer;
	useEffect(() => {
		const record = prefills.get(threadId);
		if (record && record.owned !== draftText) record.owned = null;
	}, [draftText, threadId]);

	useEffect(() => {
		if (!prefill || !offered || best === null) return;
		if (prefills.get(threadId)?.suggestionAt === suggestion.createdAt) return;
		prefills.set(threadId, { suggestionAt: suggestion.createdAt, owned: best });
		// Replaces rather than inserts: an empty composer can still hold whitespace.
		composer.replace({ text: best, mentions: [] });
	}, [prefill, offered, best, suggestion, threadId, composer]);

	// Dismissed or outdated, the prefilled text goes too, unless the user edited it.
	useEffect(() => {
		const record = prefills.get(threadId);
		if (!isLoaded || suggestion !== null || !record || record.owned === null) return;
		record.owned = null;
		composer.replace(EMPTY_DRAFT);
	}, [isLoaded, suggestion, threadId, composer]);

	const accept = useCallback(() => {
		if (best === null) return;
		composer.insert(best, { at: "end" });
		composer.focus();
	}, [composer, best]);

	const pick = useCallback(
		(text: string) => {
			if (composer.isEmpty) composer.insert(text, { at: "end" });
			else composer.replace({ text, mentions: [] });
			if (clickSends) void composer.submit({ experimental_data: null }).catch(() => composer.focus());
			else composer.focus();
		},
		[composer, clickSends],
	);

	useEffect(() => {
		if (!offered) return;
		const onKeyDown = (event: KeyboardEvent) => {
			const accepting = event.key === "Tab" || event.key === "ArrowRight";
			// Cards have their own × button; grey text has nothing to click, so Escape hides it.
			if (!accepting && !(ghost && event.key === "Escape")) return;
			if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
			const root = rootRef.current;
			const editor = root ? findEditor(root) : null;
			if (!editor || !(event.target instanceof Node) || !editor.contains(event.target)) return;
			if (!accepting) return dismiss();
			event.preventDefault();
			event.stopPropagation();
			accept();
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [offered, ghost, accept, dismiss]);

	useSwipeToAccept(rootRef, offered, accept);

	// The moment before the prefill lands draws no grey text; after the user clears the draft it does.
	const prefillPending = prefill && lastPrefill?.suggestionAt !== suggestion?.createdAt;
	const text = offered && !prefillPending ? best : null;
	const lines = composer.layout === "compact" ? 1 : 3;
	useEffect(() => {
		const root = rootRef.current;
		const editor = ghost && text !== null && root ? findEditor(root) : null;
		return editor && text !== null ? paintGhost(editor, text, lines) : undefined;
	}, [ghost, text, lines]);

	if (cards && suggestion !== null && (offered || prefilled)) {
		return (
			<SuggestionCards
				rootRef={rootRef}
				texts={suggestion.texts}
				hint={offered}
				title={clickSends ? "Send this prompt" : "Insert into the composer"}
				onPick={pick}
				onDismiss={dismiss}
			/>
		);
	}
	if (cards) return null;
	// Anchor for findEditor, and the suggestion read out to screen readers.
	return (
		<span ref={rootRef} className="sr-only" role="status" aria-live="polite">
			{text === null ? "" : `Suggested next prompt: ${text}. Press Tab to insert it.`}
		</span>
	);
}

function NextPromptBanner() {
	const composer = useComposer();
	const { scope } = composer;
	if (scope.kind !== "thread") return null;
	return <Suggestions key={scope.threadId} threadId={scope.threadId} composer={composer} />;
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
