// How many suggestion cards fit one row. Pure: app.tsx feeds it measured widths.

export const CARD_GAP_PX = 6;
/** Width of the expand toggle, taken from the row only when it is needed. */
const TOGGLE_PX = 28;

/** Every card that fits, at least the best one. An unknown width of 0 shows only that one. */
export function fitCount(widths: readonly number[], available: number): number {
	const total = widths.reduce((sum, width) => sum + width, 0) + CARD_GAP_PX * Math.max(0, widths.length - 1);
	if (total <= available) return widths.length;
	let used = 0;
	let count = 0;
	for (const width of widths) {
		used += width + (count > 0 ? CARD_GAP_PX : 0);
		if (used > available - TOGGLE_PX) break;
		count += 1;
	}
	return Math.max(1, count);
}
