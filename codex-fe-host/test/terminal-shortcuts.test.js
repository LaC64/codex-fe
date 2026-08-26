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

test("tabs and new tab button share one wrapping strip", () => {
	const html = fs.readFileSync(
		path.resolve(__dirname, "..", "renderer", "index.html"),
		"utf8",
	);
	const renderer = fs.readFileSync(
		path.resolve(__dirname, "..", "renderer", "renderer.js"),
		"utf8",
	);
	const styles = fs.readFileSync(
		path.resolve(__dirname, "..", "renderer", "styles.css"),
		"utf8",
	);

	assert.match(
		html,
		/class="tab-strip" id="tabs">\s*<button class="tab-add"/,
	);
	assert.match(renderer, /tabsElement\.appendChild\(addTabElement\);/);
	assert.match(styles, /\.tab-strip\s*\{[^}]*flex-wrap:\s*wrap;/s);
	assert.doesNotMatch(styles, /overflow-x:\s*auto;/);
	assert.match(styles, /\.tab\s*\{[^}]*max-width:\s*520px;/s);
	assert.match(styles, /grid-template-rows:\s*auto minmax\(0, 1fr\);/);
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

test("xterm owns terminal padding so FitAddon subtracts it", () => {
	const styles = fs.readFileSync(
		path.resolve(__dirname, "..", "renderer", "styles.css"),
		"utf8",
	);

	assert.doesNotMatch(styles, /\.terminal-panel\s*\{[^}]*padding:/s);
	assert.match(styles, /\.xterm\s*\{[^}]*padding:\s*9px 10px;/s);
});

test("new and resumed Codex sessions share full-trust non-alt-screen args", () => {
	const main = fs.readFileSync(
		path.resolve(__dirname, "..", "main.js"),
		"utf8",
	);

	assert.match(
		main,
		/const CODEX_LAUNCH_ARGS = \[\s*"--dangerously-bypass-approvals-and-sandbox",\s*"--no-alt-screen",\s*\];/,
	);
	assert.match(
		main,
		/\["-C", tab\.cwd, "resume", tab\.sessionId, \.\.\.CODEX_LAUNCH_ARGS\]/,
	);
	assert.match(main, /\["-C", tab\.cwd, \.\.\.CODEX_LAUNCH_ARGS\]/);
});
