const fs = require("node:fs");
const path = require("node:path");

const WORKSPACE_VERSION = 1;

function createEmptyWorkspace() {
	return {
		version: WORKSPACE_VERSION,
		tabs: [],
		activeTabId: null,
		updatedAt: new Date().toISOString(),
	};
}

function normalizeTab(value) {
	if (!value || typeof value !== "object") {
		return null;
	}
	const tabId = String(value.tabId || "").trim();
	const kind = String(value.kind || "").trim();
	const sessionId = String(value.sessionId || "").trim();
	const cwd = String(value.cwd || "").trim();
	if (
		!tabId ||
		!cwd ||
		!["session", "pending_new_chat", "powershell"].includes(kind) ||
		(kind === "session" && !sessionId)
	) {
		return null;
	}
	return {
		tabId,
		kind,
		sessionId: kind === "session" ? sessionId : "",
		cwd,
		title:
			String(value.title || "").trim() ||
			(kind === "powershell" ? "PowerShell" : "Codex Session"),
		model: kind === "powershell" ? "" : String(value.model || "").trim(),
		createdAt: String(value.createdAt || "").trim() || new Date().toISOString(),
	};
}

function uniqueSessionTabs(tabs, requestedActiveId) {
	const preferredTabBySession = new Map();
	for (const tab of tabs) {
		if (tab.kind !== "session") {
			continue;
		}
		if (
			!preferredTabBySession.has(tab.sessionId) ||
			tab.tabId === requestedActiveId
		) {
			preferredTabBySession.set(tab.sessionId, tab.tabId);
		}
	}
	return tabs.filter(
		(tab) =>
			tab.kind !== "session" ||
			preferredTabBySession.get(tab.sessionId) === tab.tabId,
	);
}

function normalizeWorkspace(value) {
	if (!value || typeof value !== "object" || value.version !== WORKSPACE_VERSION) {
		return createEmptyWorkspace();
	}
	const normalizedTabs = Array.isArray(value.tabs)
		? value.tabs.map(normalizeTab).filter(Boolean)
		: [];
	const requestedActiveId = String(value.activeTabId || "").trim();
	const tabs = uniqueSessionTabs(normalizedTabs, requestedActiveId);
	return {
		version: WORKSPACE_VERSION,
		tabs,
		activeTabId: tabs.some((tab) => tab.tabId === requestedActiveId)
			? requestedActiveId
			: tabs[0]?.tabId || null,
		updatedAt: String(value.updatedAt || "").trim() || new Date().toISOString(),
	};
}

class WorkspaceStore {
	constructor(filePath) {
		this.filePath = filePath;
	}

	load() {
		try {
			return normalizeWorkspace(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
		} catch {
			return createEmptyWorkspace();
		}
	}

	save(workspace) {
		const normalized = normalizeWorkspace(workspace);
		fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
		const temporary = `${this.filePath}.${process.pid}.tmp`;
		fs.writeFileSync(temporary, JSON.stringify(normalized, null, 2), "utf8");
		fs.renameSync(temporary, this.filePath);
	}
}

function archiveLegacyFile(filePath) {
	if (!fs.existsSync(filePath)) {
		return "";
	}
	const timestamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
	const parsed = path.parse(filePath);
	let destination = path.join(parsed.dir, `${parsed.name}.legacy-${timestamp}${parsed.ext}`);
	let suffix = 1;
	while (fs.existsSync(destination)) {
		destination = path.join(
			parsed.dir,
			`${parsed.name}.legacy-${timestamp}-${suffix++}${parsed.ext}`,
		);
	}
	fs.renameSync(filePath, destination);
	return destination;
}

function archiveLegacyState(codexHome) {
	return [
		archiveLegacyFile(path.join(codexHome, "codex-fe-workspace.json")),
		archiveLegacyFile(path.join(codexHome, "codex-fe-dashboard.json")),
	].filter(Boolean);
}

module.exports = {
	WORKSPACE_VERSION,
	WorkspaceStore,
	archiveLegacyState,
	createEmptyWorkspace,
	normalizeWorkspace,
};
