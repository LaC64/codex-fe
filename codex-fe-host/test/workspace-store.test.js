const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
	WorkspaceStore,
	archiveLegacyState,
	createEmptyWorkspace,
} = require("../workspace-store");

test("workspace store collapses duplicate sessions and preserves the active one", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fe-store-"));
	try {
		const filePath = path.join(directory, "tabs.json");
		const store = new WorkspaceStore(filePath);
		const workspace = createEmptyWorkspace();
		workspace.tabs = [
			{
				tabId: "tab-one",
				kind: "session",
				sessionId: "same-session",
				cwd: directory,
				title: "First",
				model: "gpt-test",
				createdAt: "2026-07-28T20:00:00.000Z",
			},
			{
				tabId: "shell-tab",
				kind: "powershell",
				sessionId: "",
				cwd: directory,
				title: "PowerShell",
				model: "",
				createdAt: "2026-07-28T20:00:00.500Z",
			},
			{
				tabId: "tab-two",
				kind: "session",
				sessionId: "same-session",
				cwd: directory,
				title: "Second",
				model: "gpt-test",
				createdAt: "2026-07-28T20:00:01.000Z",
			},
		];
		workspace.activeTabId = "tab-two";
		store.save(workspace);

		const loaded = store.load();
		assert.deepEqual(
			loaded.tabs.map((tab) => tab.tabId),
			["shell-tab", "tab-two"],
		);
		assert.equal(loaded.activeTabId, "tab-two");
		assert.equal(loaded.tabs[0].kind, "powershell");
		assert.equal(loaded.tabs[1].sessionId, "same-session");
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("legacy Python state is archived without importing tabs", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fe-legacy-"));
	try {
		const legacyWorkspace = path.join(directory, "codex-fe-workspace.json");
		const legacyDashboard = path.join(directory, "codex-fe-dashboard.json");
		fs.writeFileSync(legacyWorkspace, '{"tabs":[1,2,3]}', "utf8");
		fs.writeFileSync(legacyDashboard, '{"pid":123}', "utf8");

		const archived = archiveLegacyState(directory);
		assert.equal(archived.length, 2);
		assert.equal(fs.existsSync(legacyWorkspace), false);
		assert.equal(fs.existsSync(legacyDashboard), false);
		assert.ok(archived.every((item) => fs.existsSync(item)));
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("closed tab history is bounded, unique, and excludes open tabs", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fe-closed-"));
	try {
		const filePath = path.join(directory, "tabs.json");
		const store = new WorkspaceStore(filePath);
		const workspace = createEmptyWorkspace();
		workspace.tabs = [
			{
				tabId: "open-session",
				kind: "session",
				sessionId: "open-session-id",
				cwd: directory,
				title: "Open",
				model: "",
				createdAt: "2026-07-29T10:00:00.000Z",
			},
		];
		workspace.closedTabs = [
			{ ...workspace.tabs[0], tabId: "stale-open-session" },
			...Array.from({ length: 55 }, (_value, index) => ({
				tabId: `closed-${index}`,
				kind: "powershell",
				sessionId: "",
				cwd: directory,
				title: `PowerShell ${index}`,
				model: "",
				createdAt: `2026-07-29T10:${String(index).padStart(2, "0")}:00.000Z`,
			})),
			{
				tabId: "closed-54",
				kind: "powershell",
				sessionId: "",
				cwd: directory,
				title: "PowerShell 54 newest",
				model: "",
				createdAt: "2026-07-29T11:00:00.000Z",
			},
		];
		workspace.activeTabId = "open-session";
		store.save(workspace);

		const loaded = store.load();
		assert.equal(loaded.closedTabs.length, 50);
		assert.equal(loaded.closedTabs[0].tabId, "closed-5");
		assert.equal(loaded.closedTabs.at(-1).tabId, "closed-54");
		assert.equal(loaded.closedTabs.at(-1).title, "PowerShell 54 newest");
		assert.equal(
			loaded.closedTabs.some((tab) => tab.sessionId === "open-session-id"),
			false,
		);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
