import assert from "node:assert/strict";
import { test } from "node:test";
import { SwipeTracker } from "../swipe.ts";

const WIDTH = 400;

function swipe(points: Array<[number, number, number]>): { claimed: boolean; accepted: boolean } {
	const tracker = new SwipeTracker();
	const [first, ...rest] = points;
	if (!first) throw new Error("no points");
	tracker.start(first[0], first[1], first[2], WIDTH);
	const last = rest.pop() ?? first;
	let claimed = false;
	for (const [x, y, t] of rest) claimed = tracker.move(x, y, t) || claimed;
	return { claimed, accepted: tracker.end(last[0], last[1], last[2]) };
}

test("a quick horizontal swipe to the right accepts", () => {
	assert.deepEqual(swipe([[100, 50, 0], [130, 52, 80], [170, 54, 160]]), { claimed: true, accepted: true });
});

test("a short swipe does not accept", () => {
	assert.equal(swipe([[100, 50, 0], [120, 50, 50], [130, 50, 100]]).accepted, false);
});

test("a leftward or vertical swipe does not accept or claim", () => {
	assert.deepEqual(swipe([[200, 50, 0], [160, 50, 50], [120, 50, 100]]), { claimed: false, accepted: false });
	assert.deepEqual(swipe([[100, 50, 0], [104, 80, 50], [110, 140, 100]]), { claimed: false, accepted: false });
});

test("a diagonal drift past the vertical limit cancels", () => {
	assert.equal(swipe([[100, 50, 0], [140, 70, 50], [180, 90, 100]]).accepted, false);
});

test("a slow swipe does not accept", () => {
	assert.equal(swipe([[100, 50, 0], [140, 50, 600], [180, 50, 1200]]).accepted, false);
});

test("a swipe from the screen edge is left to the browser", () => {
	assert.deepEqual(swipe([[10, 50, 0], [40, 50, 50], [90, 50, 100]]), { claimed: false, accepted: false });
	assert.equal(swipe([[WIDTH - 10, 50, 0], [WIDTH - 5, 50, 50], [WIDTH, 50, 100]]).accepted, false);
});

test("end without start, and cancel, do not accept", () => {
	const tracker = new SwipeTracker();
	assert.equal(tracker.end(200, 50, 100), false);
	tracker.start(100, 50, 0, WIDTH);
	tracker.cancel();
	assert.equal(tracker.end(200, 50, 100), false);
});
