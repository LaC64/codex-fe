const fs = require("node:fs");
const path = require("node:path");

function normalizePath(value) {
	return path.resolve(String(value || "")).toLowerCase();
}

function dateDirectory(sessionsRoot, timestamp) {
	const date = new Date(timestamp);
	const year = String(date.getFullYear());
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return path.join(sessionsRoot, year, month, day);
}

function candidateDateDirectories(sessionsRoot, timestamp) {
	const base = new Date(timestamp);
	const directories = new Set();
	for (const offset of [-1, 0, 1]) {
		const date = new Date(base);
		date.setDate(date.getDate() + offset);
		directories.add(dateDirectory(sessionsRoot, date));
	}
	directories.add(dateDirectory(sessionsRoot, new Date()));
	return [...directories];
}

function readSessionMeta(filePath) {
	try {
		const descriptor = fs.openSync(filePath, "r");
		try {
			const buffer = Buffer.alloc(64 * 1024);
			const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
			const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0];
			const item = JSON.parse(firstLine);
			if (item.type !== "session_meta" || !item.payload?.id) {
				return null;
			}
			return {
				sessionId: String(item.payload.id),
				cwd: String(item.payload.cwd || ""),
				createdAt: String(item.payload.timestamp || item.timestamp || ""),
				filePath,
			};
		} finally {
			fs.closeSync(descriptor);
		}
	} catch {
		return null;
	}
}

function findCandidates(codexHome, pendingTabs) {
	const sessionsRoot = path.join(codexHome, "sessions");
	const files = new Set();
	for (const tab of pendingTabs) {
		for (const directory of candidateDateDirectories(sessionsRoot, tab.createdAt)) {
			try {
				for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
					if (entry.isFile() && entry.name.endsWith(".jsonl")) {
						files.add(path.join(directory, entry.name));
					}
				}
			} catch {
				// A missing date directory simply has no candidates.
			}
		}
	}
	return [...files].map(readSessionMeta).filter(Boolean);
}

function resolvePendingTabs(workspace, codexHome) {
	const result = { value: false };
	const pendingTabs = workspace.tabs
		.filter((tab) => tab.kind === "pending_new_chat")
		.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
	if (!pendingTabs.length) {
		return result;
	}
	const knownIds = new Set(
		workspace.tabs.filter((tab) => tab.kind === "session").map((tab) => tab.sessionId),
	);
	const candidates = findCandidates(codexHome, pendingTabs)
		.filter((candidate) => !knownIds.has(candidate.sessionId))
		.sort((left, right) => left.createdAt.localeCompare(right.createdAt));

	for (const tab of pendingTabs) {
		const launchedAt = Date.parse(tab.createdAt);
		const index = candidates.findIndex((candidate) => {
			const candidateTime = Date.parse(candidate.createdAt);
			return (
				normalizePath(candidate.cwd) === normalizePath(tab.cwd) &&
				(!Number.isFinite(launchedAt) ||
					!Number.isFinite(candidateTime) ||
					candidateTime >= launchedAt - 10000)
			);
		});
		if (index < 0) {
			continue;
		}
		const [candidate] = candidates.splice(index, 1);
		tab.kind = "session";
		tab.sessionId = candidate.sessionId;
		knownIds.add(candidate.sessionId);
		result.value = true;
	}
	return result;
}

function loadSessionTitles(indexFile) {
	const titles = new Map();
	try {
		for (const line of fs.readFileSync(indexFile, "utf8").split(/\r?\n/)) {
			if (!line.trim()) {
				continue;
			}
			try {
				const item = JSON.parse(line);
				if (item.id && item.thread_name) {
					titles.set(String(item.id), String(item.thread_name));
				}
			} catch {
				// Ignore malformed index rows.
			}
		}
	} catch {
		// The session index may not exist on first run.
	}
	return titles;
}

module.exports = {
	loadSessionTitles,
	readSessionMeta,
	resolvePendingTabs,
};
