const assert = require("node:assert/strict");
const test = require("node:test");
const {
	consumeExitMarkers,
	flushMarkerRemainder,
} = require("../runtime-output");

const marker = "\x1b]9;codex-fe-exit=test-token\x07";

test("Codex exit marker is removed from terminal output", () => {
	const state = { markerRemainder: "" };
	const result = consumeExitMarkers(state, `before${marker}after`, marker);

	assert.equal(result.visibleData, "beforeafter");
	assert.equal(result.markerCount, 1);
	assert.equal(state.markerRemainder, "");
});

test("Codex exit marker is recognized across PTY chunks", () => {
	const state = { markerRemainder: "" };
	const split = Math.floor(marker.length / 2);
	const first = consumeExitMarkers(state, `output${marker.slice(0, split)}`, marker);
	const second = consumeExitMarkers(state, `${marker.slice(split)}prompt`, marker);

	assert.equal(first.visibleData, "output");
	assert.equal(first.markerCount, 0);
	assert.equal(second.visibleData, "prompt");
	assert.equal(second.markerCount, 1);
	assert.equal(flushMarkerRemainder(state), "");
});

test("partial non-marker output is preserved", () => {
	const state = { markerRemainder: "" };
	const first = consumeExitMarkers(state, "text\x1b", marker);
	const second = consumeExitMarkers(state, "[31mred", marker);

	assert.equal(first.visibleData, "text");
	assert.equal(second.visibleData, "\x1b[31mred");
	assert.equal(flushMarkerRemainder(state), "");
});
