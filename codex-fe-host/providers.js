const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CODEX_LAUNCH_ARGS = [
	"--dangerously-bypass-approvals-and-sandbox",
	"--no-alt-screen",
];
const CLAUDE_LAUNCH_ARGS = ["--dangerously-skip-permissions"];
const claudeMetadata = new Map();

function normalizeProvider(value) {
	const provider = String(value || "codex").trim();
	if (!["codex", "claude"].includes(provider)) {
		throw new Error(`Unsupported provider: ${provider}`);
	}
	return provider;
}

function sessionIdentity(tab) {
	return `${normalizeProvider(tab.provider)}:${tab.sessionId}`;
}

function resolveProviderExecutable(provider) {
	const configured = process.env[`CODEX_FE_${provider.toUpperCase()}_EXE`];
	if (configured) {
		if (!fs.existsSync(configured)) {
			throw new Error(`Configured ${provider} executable does not exist: ${configured}`);
		}
		return configured;
	}
	const candidates = provider === "codex"
		? [process.env.APPDATA && path.join(process.env.APPDATA, "npm", "codex.cmd")]
		: [];
	for (const candidate of candidates) {
		if (candidate && fs.existsSync(candidate)) {
			return candidate;
		}
	}
	for (const name of [`${provider}.exe`, `${provider}.cmd`, provider]) {
		const result = spawnSync("where.exe", [name], { encoding: "utf8", windowsHide: true });
		const candidate = String(result.stdout || "").split(/\r?\n/).find(Boolean);
		if (candidate) {
			return candidate.trim();
		}
	}
	throw new Error(`Could not find ${provider === "claude" ? "Claude Code" : "Codex"} on PATH.`);
}

function claudeHome(tab) {
	return path.resolve(tab.providerHome || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
}

// Setting even the default data directory relocates Claude's separate ~/.claude.json.
function claudeConfigDir(tab, environment = process.env) {
	const defaultHome = path.join(os.homedir(), ".claude");
	const configured = environment.CLAUDE_CONFIG_DIR;
	const home = path.resolve(tab.providerHome || configured || defaultHome);
	const explicitlyConfigured = configured && path.relative(home, path.resolve(configured)) === "";
	return path.relative(defaultHome, home) === "" && !explicitlyConfigured ? "" : home;
}

function findClaudeTranscript(tab) {
	const projects = path.join(claudeHome(tab), "projects");
	if (tab.sessionFile) {
		const relative = path.relative(projects, tab.sessionFile);
		if (!relative.startsWith("..") && !path.isAbsolute(relative) && fs.existsSync(tab.sessionFile)) {
			return tab.sessionFile;
		}
	}
	if (!/^[0-9a-f-]{36}$/i.test(tab.sessionId)) {
		return "";
	}
	try {
		for (const entry of fs.readdirSync(projects, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				const candidate = path.join(projects, entry.name, `${tab.sessionId}.jsonl`);
				if (fs.existsSync(candidate)) {
					return candidate;
				}
			}
		}
	} catch {
		// A new chat may not have written its transcript yet.
	}
	return "";
}

function metadataSignature(descriptor, offset) {
	const probes = [];
	for (const position of new Set([0, Math.max(0, Math.floor(offset / 2) - 128), Math.max(0, offset - 256)])) {
		const probe = Buffer.alloc(Math.min(256, offset - position));
		fs.readSync(descriptor, probe, 0, probe.length, position);
		probes.push(probe.toString("base64"));
	}
	return probes.join(":");
}

// Stream complete records so initial indexing uses memory proportional to one row.
function readClaudeRows(descriptor, start, size, applyRow) {
	let position = start;
	let offset = start;
	let fragments = [];
	while (position < size) {
		const buffer = Buffer.alloc(Math.min(64 * 1024, size - position));
		const count = fs.readSync(descriptor, buffer, 0, buffer.length, position);
		if (!count) break;
		let lineStart = 0;
		for (let end = buffer.indexOf(10); end >= 0 && end < count; end = buffer.indexOf(10, end + 1)) {
			fragments.push(buffer.subarray(lineStart, end));
			try {
				applyRow(JSON.parse(Buffer.concat(fragments).toString("utf8")));
			} catch {
				// Ignore malformed complete rows; the partial final row is retried next time.
			}
			fragments = [];
			lineStart = end + 1;
			offset = position + lineStart;
		}
		if (lineStart < count) fragments.push(buffer.subarray(lineStart, count));
		position += count;
	}
	return offset;
}

// Cache only metadata for managed tabs; consume complete appended records on each refresh.
function readClaudeMetadata(tab) {
	const file = findClaudeTranscript(tab);
	if (!file) {
		return null;
	}
	try {
		const stat = fs.statSync(file);
		let cached = claudeMetadata.get(file);
		if (cached && cached.size === stat.size && cached.mtime === stat.mtimeMs && cached.inode === stat.ino) {
			return { ...cached.state, file };
		}
		const descriptor = fs.openSync(file, "r");
		try {
			if (!cached || cached.size >= stat.size || cached.inode !== stat.ino ||
				cached.signature !== metadataSignature(descriptor, cached.offset)) {
				cached = { offset: 0, state: {} };
			}
			cached.offset = readClaudeRows(descriptor, cached.offset, stat.size, (row) => {
				if (row.isSidechain || (row.sessionId && row.sessionId !== tab.sessionId)) {
					return;
				}
				if (row.type === "custom-title") cached.state.customTitle = row.customTitle || "";
				if (row.type === "ai-title") cached.state.aiTitle = row.aiTitle || "";
				if (row.type === "system" && row.subtype === "local_command" &&
					row.commandRun?.command === "rename" &&
					typeof row.commandRun.args === "string" &&
					typeof row.content === "string" &&
					row.content.startsWith("<local-command-stdout>Session renamed to:")) {
					cached.state.renameTitle = row.commandRun.args.trim();
				}
				if (["user", "assistant"].includes(row.type) && row.message) {
					cached.state.hasMessages = true;
					if (row.cwd) cached.state.cwd = row.cwd;
					if (row.message.model) cached.state.model = row.message.model;
				}
			});
			Object.assign(cached, {
				size: stat.size, mtime: stat.mtimeMs, inode: stat.ino,
				signature: metadataSignature(descriptor, cached.offset),
			});
			claudeMetadata.set(file, cached);
			return { ...cached.state, file };
		} finally {
			fs.closeSync(descriptor);
		}
	} catch {
		return null;
	}
}

// Keep provider-specific flags at the launch boundary; UUIDs never cross providers.
function providerLaunchArgs(tab) {
	if (normalizeProvider(tab.provider) === "claude") {
		const resume = tab.kind === "session" || readClaudeMetadata(tab)?.hasMessages;
		return [resume ? "--resume" : "--session-id", tab.sessionId, ...CLAUDE_LAUNCH_ARGS];
	}
	return tab.kind === "session" && tab.sessionId
		? ["-C", tab.cwd, "resume", tab.sessionId, ...CODEX_LAUNCH_ARGS]
		: ["-C", tab.cwd, ...CODEX_LAUNCH_ARGS];
}

module.exports = {
	normalizeProvider, sessionIdentity, resolveProviderExecutable,
	claudeHome, claudeConfigDir, readClaudeMetadata, providerLaunchArgs,
};
