// Paints a suggestion as grey text over bb's empty composer editor. The overlay
// sits beside the editor, never inside it, so the draft stays empty until the
// user accepts; bb's own placeholder is hidden while it shows.

const ACTIVE_ATTRIBUTE = "data-next-prompt-ghost";
const STYLE_ID = "next-prompt-ghost-style";
const STYLE = `
[${ACTIVE_ATTRIBUTE}] p.is-editor-empty:first-child::before { content: none !important; }
.next-prompt-ghost { position: absolute; z-index: 1; display: flex; align-items: baseline; gap: 0.6em; overflow: hidden; pointer-events: none; user-select: none; color: var(--muted-foreground); opacity: 0.7; }
.next-prompt-ghost > span { min-width: 0; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; white-space: pre-wrap; }
.next-prompt-ghost > kbd { flex-shrink: 0; padding: 0 0.35em; border: 1px solid currentColor; border-radius: 4px; font: 10px/1.5 ui-monospace, monospace; white-space: nowrap; }
.next-prompt-ghost .next-prompt-swipe { display: none; }
@media (pointer: coarse) {
	.next-prompt-ghost .next-prompt-tab { display: none; }
	.next-prompt-ghost .next-prompt-swipe { display: block; }
}
`;

let styleUsers = 0;

function retainStyle(doc: Document): () => void {
	styleUsers += 1;
	if (!doc.getElementById(STYLE_ID)) {
		const style = doc.createElement("style");
		style.id = STYLE_ID;
		style.textContent = STYLE;
		doc.head.append(style);
	}
	return () => {
		styleUsers -= 1;
		if (styleUsers === 0) doc.getElementById(STYLE_ID)?.remove();
	};
}

/** Show `text` over `editor` until the returned function is called. */
export function paintGhost(editor: HTMLElement, text: string, lines: number): () => void {
	const doc = editor.ownerDocument;
	const win = doc.defaultView;
	const parent = editor.parentElement;
	if (!win || !parent) return () => {};
	const releaseStyle = retainStyle(doc);
	const originalPosition = parent.style.position;
	const repositioned = win.getComputedStyle(parent).position === "static";
	if (repositioned) parent.style.position = "relative";

	const overlay = doc.createElement("div");
	overlay.className = "next-prompt-ghost";
	overlay.setAttribute("aria-hidden", "true");
	const label = doc.createElement("span");
	label.textContent = text;
	label.style.webkitLineClamp = String(lines);
	const tab = doc.createElement("kbd");
	tab.className = "next-prompt-tab";
	tab.textContent = "Tab";
	const swipe = doc.createElement("kbd");
	swipe.className = "next-prompt-swipe";
	swipe.textContent = "Swipe →";
	overlay.append(label, tab, swipe);
	parent.append(overlay);
	editor.setAttribute(ACTIVE_ATTRIBUTE, "");

	const form = editor.closest<HTMLElement>("form[data-promptbox]");
	// Align with the first paragraph, where bb's own placeholder is drawn.
	const update = () => {
		const line = editor.querySelector<HTMLElement>("p") ?? editor;
		const font = win.getComputedStyle(line);
		const box = line.getBoundingClientRect();
		const editorBox = editor.getBoundingClientRect();
		const container = parent.getBoundingClientRect();
		const lineHeight = parseFloat(font.lineHeight) || parseFloat(font.fontSize) * 1.5 || 20;
		overlay.hidden = form?.hasAttribute("data-promptbox-voice-active") ?? false;
		Object.assign(overlay.style, {
			left: `${box.left - container.left + parent.scrollLeft}px`,
			top: `${box.top - container.top + parent.scrollTop}px`,
			width: `${Math.max(0, editorBox.right - box.left)}px`,
			maxHeight: `${lineHeight * lines}px`,
			font: font.font,
			lineHeight: font.lineHeight,
			letterSpacing: font.letterSpacing,
		});
	};
	update();
	const resize = win.ResizeObserver ? new win.ResizeObserver(update) : null;
	resize?.observe(editor);
	resize?.observe(parent);
	// Voice input draws its own UI over the editor.
	const voice = form ? new win.MutationObserver(update) : null;
	if (form) voice?.observe(form, { attributes: true, attributeFilter: ["data-promptbox-voice-active"] });

	return () => {
		resize?.disconnect();
		voice?.disconnect();
		overlay.remove();
		editor.removeAttribute(ACTIVE_ATTRIBUTE);
		if (repositioned) parent.style.position = originalPosition;
		releaseStyle();
	};
}
