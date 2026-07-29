const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("clipboard paste has only xterm's native input path", () => {
	const hostRoot = path.resolve(__dirname, "..");
	const renderer = fs.readFileSync(
		path.join(hostRoot, "renderer", "renderer.js"),
		"utf8",
	);
	const sources = [
		"main.js",
		"preload.js",
		path.join("renderer", "renderer.js"),
	]
		.map((file) => fs.readFileSync(path.join(hostRoot, file), "utf8"))
		.join("\n");

	assert.doesNotMatch(sources, /clipboard:read-text/);
	assert.doesNotMatch(sources, /\.readText\(/);
	assert.doesNotMatch(sources, /terminal\.paste\(/);
	assert.match(
		renderer,
		/event\.key\.toLowerCase\(\) === "v"\)\s*\{\s*return false;/,
	);
});

test("Ctrl+Shift+T restores through the host workspace", () => {
	const renderer = fs.readFileSync(
		path.resolve(__dirname, "..", "renderer", "renderer.js"),
		"utf8",
	);

	assert.match(renderer, /event\.ctrlKey\s*&&\s*event\.shiftKey/);
	assert.match(renderer, /event\.key\.toLowerCase\(\) === "t"/);
	assert.match(renderer, /window\.hostAPI\.restoreClosedTab\(\)/);
});
