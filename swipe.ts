// Recognizes a deliberate one-finger swipe to the right inside the composer,
// the touch counterpart of Tab. Pure: app.tsx feeds it touch coordinates.

/** Touches starting this close to a screen edge belong to the browser's back/forward gesture. */
const EDGE_PX = 24;
const ACCEPT_DX = 48;
/** Horizontal travel after which the gesture is claimed from native scrolling. */
const CLAIM_DX = 12;
const MAX_DY = 24;
const MAX_MS = 1_000;

export class SwipeTracker {
	private origin: { x: number; y: number; t: number } | null = null;

	start(x: number, y: number, t: number, viewportWidth: number): void {
		this.origin = x < EDGE_PX || x > viewportWidth - EDGE_PX ? null : { x, y, t };
	}

	cancel(): void {
		this.origin = null;
	}

	/** True when the move is clearly horizontal, so the caller should prevent native handling. */
	move(x: number, y: number, t: number): boolean {
		const delta = this.delta(x, y, t);
		return delta !== null && delta.dx >= CLAIM_DX && delta.dx >= delta.dy * 2;
	}

	/** True when the released gesture accepts the suggestion. */
	end(x: number, y: number, t: number): boolean {
		const delta = this.delta(x, y, t);
		this.origin = null;
		return delta !== null && delta.dx >= ACCEPT_DX && delta.dx >= delta.dy * 2;
	}

	private delta(x: number, y: number, t: number): { dx: number; dy: number } | null {
		if (!this.origin) return null;
		const dx = x - this.origin.x;
		const dy = Math.abs(y - this.origin.y);
		if (t - this.origin.t > MAX_MS || dx < -CLAIM_DX || dy > MAX_DY || (dy > CLAIM_DX && dy >= Math.abs(dx))) {
			this.origin = null;
			return null;
		}
		return { dx, dy };
	}
}
