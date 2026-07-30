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

test("new tab button follows the tabs in their shared overflow strip", () => {
	const html = fs.readFileSync(
		path.resolve(__dirname, "..", "renderer", "index.html"),
		"utf8",
	);
	const styles = fs.readFileSync(
		path.resolve(__dirname, "..", "renderer", "styles.css"),
		"utf8",
	);

	assert.match(
		html,
		/class="tab-strip">\s*<div class="tabs" id="tabs"><\/div>\s*<button class="tab-add"/,
	);
	assert.match(styles, /\.tab-strip\s*\{[^}]*overflow-x:\s*auto;/s);
	assert.match(styles, /\.tabs\s*\{[^}]*flex:\s*0 0 auto;/s);
});

test("PTY output drives one shared tab activity spinner", () => {
	const renderer = fs.readFileSync(
		path.resolve(__dirname, "..", "renderer", "renderer.js"),
		"utf8",
	);
	const styles = fs.readFileSync(
		path.resolve(__dirname, "..", "renderer", "styles.css"),
		"utf8",
	);

	assert.match(renderer, /const ACTIVITY_IDLE_MS = 1200;/);
	assert.match(renderer, /const ACTIVITY_FRAMES = \[/);
	assert.match(renderer, /let activityAnimationTimer = null;/);
	assert.match(
		renderer,
		/onData\(\(tabId, data\) => \{[\s\S]*noteTabOutput\(tabId\);[\s\S]*\}\);/,
	);
	assert.match(styles, /\.shell-mark\s*\{[^}]*width:\s*20px;/s);
});
