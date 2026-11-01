import assert from "node:assert/strict";
import { test } from "node:test";
import { CARD_GAP_PX, fitCount } from "../cards.ts";

test("all cards fit, so none is hidden and no room goes to the toggle", () => {
	assert.equal(fitCount([100, 100, 100], 300 + 2 * CARD_GAP_PX), 3);
});

test("cards that do not fit leave room for the toggle", () => {
	assert.equal(fitCount([100, 100, 100], 300), 2);
	assert.equal(fitCount([100, 100, 100], 100 + CARD_GAP_PX + 100), 1);
});

test("the best card always shows", () => {
	assert.equal(fitCount([500, 100], 200), 1);
	assert.equal(fitCount([100], 50), 1);
});

test("an unknown width shows only the best card", () => {
	assert.equal(fitCount([100, 100, 100], 0), 1);
});
