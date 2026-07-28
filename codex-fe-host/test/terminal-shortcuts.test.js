const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("clipboard paste has only xterm's native input path", () => {
	const hostRoot = path.resolve(__dirname, "..");
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
});
