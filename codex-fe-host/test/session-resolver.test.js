const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
	loadSessionTitles,
	resolvePendingTabs,
} = require("../session-resolver");

function sessionDirectory(codexHome, timestamp) {
	const date = new Date(timestamp);
	return path.join(
		codexHome,
		"sessions",
		String(date.getFullYear()),
		String(date.getMonth() + 1).padStart(2, "0"),
		String(date.getDate()).padStart(2, "0"),
	);
}

test("pending chat resolves to a newly created session with the same cwd", () => {
	const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fe-resolver-"));
	try {
		const launchedAt = new Date().toISOString();
		const cwd = path.join(codexHome, "work");
		fs.mkdirSync(cwd);
		const directory = sessionDirectory(codexHome, launchedAt);
		fs.mkdirSync(directory, { recursive: true });
		const sessionId = "019fffff-1111-7222-8333-444444444444";
		const meta = {
			timestamp: launchedAt,
			type: "session_meta",
			payload: { id: sessionId, timestamp: launchedAt, cwd },
		};
		fs.writeFileSync(
			path.join(directory, `rollout-${sessionId}.jsonl`),
			`${JSON.stringify(meta)}\n`,
			"utf8",
		);
		const workspace = {
			tabs: [
				{
					tabId: "pending",
					kind: "pending_new_chat",
					sessionId: "",
					cwd,
					title: "Codex New Chat",
					model: "",
					createdAt: launchedAt,
				},
			],
		};

		const changed = resolvePendingTabs(workspace, codexHome);
		assert.equal(changed.value, true);
		assert.equal(workspace.tabs[0].kind, "session");
		assert.equal(workspace.tabs[0].sessionId, sessionId);
	} finally {
		fs.rmSync(codexHome, { recursive: true, force: true });
	}
});

test("latest session index title is used", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fe-titles-"));
	try {
		const indexFile = path.join(directory, "session_index.jsonl");
		fs.writeFileSync(
			indexFile,
			[
				JSON.stringify({ id: "one", thread_name: "Old" }),
				JSON.stringify({ id: "one", thread_name: "Renamed" }),
			].join("\n"),
			"utf8",
		);
		assert.equal(loadSessionTitles(indexFile).get("one"), "Renamed");
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
