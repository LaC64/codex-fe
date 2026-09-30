const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { claudeConfigDir, providerLaunchArgs, readClaudeMetadata } = require("../providers");
const { normalizeWorkspace, tabsShareIdentity } = require("../workspace-store");
const { refreshClaudeTabs, resolvePendingTabs } = require("../session-resolver");

test("default Claude data home does not override the global configuration location", () => {
	const defaultHome = path.join(os.homedir(), ".claude");
	assert.equal(claudeConfigDir({}, {}), "");
	assert.equal(claudeConfigDir({ providerHome: defaultHome }, {}), "");
	assert.equal(claudeConfigDir({ providerHome: path.join(defaultHome, ".") }, {}), "");
	assert.equal(claudeConfigDir({ providerHome: defaultHome }, {
		CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), "other-claude-config"),
	}), "");
	if (process.platform === "win32") {
		assert.equal(claudeConfigDir({ providerHome: defaultHome.toUpperCase() }, {}), "");
	}
});

test("custom and explicitly inherited Claude configuration directories remain supported", () => {
	const customHome = path.join(os.tmpdir(), "custom-claude-config");
	const defaultHome = path.join(os.homedir(), ".claude");
	assert.equal(claudeConfigDir({ providerHome: customHome }, {}), customHome);
	assert.equal(claudeConfigDir({}, { CLAUDE_CONFIG_DIR: customHome }), customHome);
	assert.equal(claudeConfigDir({ providerHome: defaultHome }, {
		CLAUDE_CONFIG_DIR: defaultHome,
	}), defaultHome);
});

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

test("successful Claude fork rename survives later stale title metadata", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fe-claude-rename-"));
	try {
		const id = "cccccccc-1111-4222-8333-444444444444";
		const directory = path.join(home, "projects", "fork");
		fs.mkdirSync(directory, { recursive: true });
		const file = path.join(directory, `${id}.jsonl`);
		const tab = { tabId: "fork", provider: "claude", providerHome: home,
			kind: "session", sessionId: id, cwd: home, title: "Performance Testing" };
		const workspace = { tabs: [tab] };
		const write = (rows, mode = "append") => fs[mode === "append" ? "appendFileSync" : "writeFileSync"](
			file, rows.map(row => JSON.stringify({ sessionId: id, ...row }) + "\n").join(""));
		write([
			{ type: "user", message: { content: "Forked session" } },
			{ type: "custom-title", customTitle: "Performance Testing" },
			{ type: "custom-title", customTitle: "Performance Testing RVT" },
			{ type: "system", subtype: "local_command",
				content: "<local-command-stdout>Session renamed to: Performance Testing RVT</local-command-stdout>",
				commandRun: { command: "rename", args: "Performance Testing RVT" } },
			{ type: "custom-title", customTitle: "Performance Testing" },
			{ type: "agent-name", agentName: "Performance Testing" },
		], "write");
		assert.equal(refreshClaudeTabs(workspace), true);
		assert.equal(tab.title, "Performance Testing RVT");
		assert.equal(refreshClaudeTabs(workspace), false);
		write([{ type: "custom-title", customTitle: "Performance Testing" }]);
		assert.equal(refreshClaudeTabs(workspace), false);
		write([{ type: "system", subtype: "local_command",
			content: "<local-command-stdout>Session renamed to: Final Name</local-command-stdout>",
			commandRun: { command: "rename", args: "Final Name" } }]);
		assert.equal(refreshClaudeTabs(workspace), true);
		assert.equal(tab.title, "Final Name");
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
