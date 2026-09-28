const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { providerLaunchArgs, readClaudeMetadata } = require("../providers");
const { normalizeWorkspace, tabsShareIdentity } = require("../workspace-store");
const { refreshClaudeTabs, resolvePendingTabs } = require("../session-resolver");

test("legacy workspace is Codex and same UUID across providers stays distinct", () => {
	const legacy = { tabId: "cx", kind: "session", sessionId: "same", cwd: os.tmpdir() };
	const claude = { ...legacy, tabId: "cl", provider: "claude" };
	const state = normalizeWorkspace({ version: 1, tabs: [legacy, claude], closedTabs: [
		{ ...legacy, tabId: "old-cx" }, { ...claude, tabId: "old-cl" },
	] });
	assert.equal(state.tabs.length, 2);
	assert.equal(state.tabs[0].provider, "codex");
	assert.equal(state.closedTabs.length, 0);
	assert.equal(tabsShareIdentity(state.tabs[0], state.tabs[1]), false);
});

test("Claude new-chat IDs persist and resolve only to their own transcript", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fe-claude-"));
	try {
		const id = "aaaaaaaa-1111-4222-8333-444444444444";
		const directory = path.join(home, "projects", "test-project");
		fs.mkdirSync(directory, { recursive: true });
		const file = path.join(directory, `${id}.jsonl`);
		const initial = { tabId: "new", provider: "claude", providerHome: home,
			kind: "pending_new_chat", sessionId: id, cwd: home, title: "Claude New Chat" };
		const state = normalizeWorkspace({ version: 1, tabs: [initial] });
		const tab = state.tabs[0];
		assert.equal(tab.sessionId, id);
		assert.deepEqual(providerLaunchArgs(tab), ["--session-id", id, "--dangerously-skip-permissions"]);
		fs.writeFileSync(file, `${JSON.stringify({ type: "ai-title", aiTitle: "Generated", sessionId: id })}\n`);
		assert.equal(refreshClaudeTabs(state), false);
		assert.equal(resolvePendingTabs(state, home).value, false);
		fs.appendFileSync(file, [
			{ type: "custom-title", customTitle: "My Name", sessionId: id },
			{ type: "assistant", sessionId: id, cwd: home, message: { model: "claude-test" } },
			{ type: "ai-title", aiTitle: "Later generated", sessionId: id },
		].map((row) => `${JSON.stringify(row)}\n`).join(""));
		assert.equal(refreshClaudeTabs(state), true);
		assert.equal(tab.kind, "session");
		assert.equal(tab.title, "My Name");
		assert.equal(tab.model, "claude-test");
		assert.deepEqual(providerLaunchArgs(tab), ["--resume", id, "--dangerously-skip-permissions"]);
		assert.equal(refreshClaudeTabs(state), false);
		fs.writeFileSync(file, `${JSON.stringify({ type: "user", sessionId: id, message: { content: "Reset" } })}\n`);
		const reset = readClaudeMetadata(tab);
		assert.equal(reset.customTitle, undefined);
		assert.equal(reset.hasMessages, true);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("Claude metadata streams large rows and retries incomplete title records", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fe-claude-stream-"));
	try {
		const id = "bbbbbbbb-1111-4222-8333-444444444444";
		const directory = path.join(home, "projects", "large");
		fs.mkdirSync(directory, { recursive: true });
		const file = path.join(directory, `${id}.jsonl`);
		const tab = { provider: "claude", providerHome: home, sessionId: id };
		fs.writeFileSync(file, [
			{ type: "user", sessionId: id, message: { content: "First" } },
			{ type: "system", content: "padding".repeat(200000) },
			{ type: "custom-title", sessionId: id, customTitle: "Buried title" },
			{ type: "system", content: "padding".repeat(200000) },
		].map(row => JSON.stringify(row) + "\n").join(""));
		assert.equal(readClaudeMetadata(tab).customTitle, "Buried title");
		const incomplete = JSON.stringify({ type: "custom-title", sessionId: id, customTitle: "Finished" });
		fs.appendFileSync(file, incomplete.slice(0, 20));
		assert.equal(readClaudeMetadata(tab).customTitle, "Buried title");
		fs.appendFileSync(file, incomplete.slice(20) + "\n");
		assert.equal(readClaudeMetadata(tab).customTitle, "Finished");
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});
