const { app, BrowserWindow, clipboard, ipcMain } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const pty = require("node-pty");
const {
	archiveLegacyState,
	createEmptyWorkspace,
	WorkspaceStore,
} = require("./workspace-store");
const {
	loadSessionTitles,
	resolvePendingTabs,
} = require("./session-resolver");

const FULL_TRUST_ARGS = ["--dangerously-bypass-approvals-and-sandbox"];
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_BACKLOG_CHARS = 128 * 1024;

let mainWindow = null;
let commandServer = null;
let discoveryFile = null;
let discoveryToken = null;
let workspaceStore = null;
let workspace = createEmptyWorkspace();
let codexHome = null;
let shuttingDown = false;
let resolverTimer = null;
const runtimes = new Map();

function argumentValue(name) {
	const index = process.argv.indexOf(name);
	return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : "";
}

function resolveCodexHome() {
	const configured = argumentValue("--codex-home");
	return configured ? path.resolve(configured) : path.join(os.homedir(), ".codex");
}

function normalizeCwd(value) {
	const candidate = String(value || "").trim();
	if (!candidate) {
		throw new Error("A working folder is required.");
	}
	const resolved = path.resolve(candidate);
	if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
		throw new Error(`Working folder does not exist: ${resolved}`);
	}
	return resolved;
}

function quotePowerShell(value) {
	return `'${String(value).replaceAll("'", "''")}'`;
}

function resolveCodexExecutable() {
	const configured = process.env.CODEX_FE_CODEX_EXE;
	if (configured && fs.existsSync(configured)) {
		return configured;
	}
	const appDataCandidate = process.env.APPDATA
		? path.join(process.env.APPDATA, "npm", "codex.cmd")
		: "";
	if (appDataCandidate && fs.existsSync(appDataCandidate)) {
		return appDataCandidate;
	}
	for (const name of ["codex.cmd", "codex.exe", "codex"]) {
		const result = spawnSync("where.exe", [name], {
			encoding: "utf8",
			windowsHide: true,
		});
		const candidate = String(result.stdout || "").split(/\r?\n/).find(Boolean);
		if (candidate) {
			return candidate.trim();
		}
	}
	throw new Error("Could not find Codex on PATH.");
}

function makePowerShellCommand(tab) {
	const codexExecutable = resolveCodexExecutable();
	const title = quotePowerShell(tab.title || "Codex");
	const cwd = quotePowerShell(tab.cwd);
	const executable = quotePowerShell(codexExecutable);
	const args =
		tab.kind === "session" && tab.sessionId
			? ["-C", tab.cwd, "resume", tab.sessionId, ...FULL_TRUST_ARGS]
			: ["-C", tab.cwd, ...FULL_TRUST_ARGS];
	const argsList = args.map(quotePowerShell).join(", ");
	return [
		`$Host.UI.RawUI.WindowTitle = ${title}`,
		`Set-Location -LiteralPath ${cwd}`,
		`$codexExecutable = ${executable}`,
		`$codexArgs = @(${argsList})`,
		"& $codexExecutable @codexArgs",
	].join("; ");
}

function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1280,
		height: 800,
		minWidth: 720,
		minHeight: 420,
		backgroundColor: "#111111",
		title: "Codex-FE Host",
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});

	mainWindow.setMenuBarVisibility(false);
	mainWindow.loadFile("renderer/index.html");
	mainWindow.on("closed", () => {
		mainWindow = null;
	});
}

function publicWorkspace() {
	return {
		version: workspace.version,
		tabs: workspace.tabs.map((tab) => ({ ...tab })),
		activeTabId: workspace.activeTabId,
	};
}

function notifyWorkspaceChanged() {
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send("workspace:changed", publicWorkspace());
	}
}

function commitWorkspace() {
	workspace.updatedAt = new Date().toISOString();
	workspaceStore.save(workspace);
	notifyWorkspaceChanged();
}

function focusWindow() {
	if (!mainWindow || mainWindow.isDestroyed()) {
		return;
	}
	if (mainWindow.isMinimized()) {
		mainWindow.restore();
	}
	mainWindow.show();
	mainWindow.focus();
}

function appendBacklog(runtime, data) {
	runtime.backlog += data;
	if (runtime.backlog.length > MAX_BACKLOG_CHARS) {
		runtime.backlog = runtime.backlog.slice(-MAX_BACKLOG_CHARS);
	}
}

function spawnTab(tab) {
	const existing = runtimes.get(tab.tabId);
	if (existing && !existing.exited) {
		return existing;
	}

	const runtime = {
		pty: null,
		backlog: "",
		attached: false,
		exited: false,
		exitCode: null,
	};
	runtimes.set(tab.tabId, runtime);

	try {
		const shellCwd = fs.existsSync(tab.cwd) ? tab.cwd : os.homedir();
		const command = fs.existsSync(tab.cwd)
			? makePowerShellCommand(tab)
			: `Write-Host ${quotePowerShell(`Saved folder no longer exists: ${tab.cwd}`)} -ForegroundColor Red`;
		runtime.pty = pty.spawn(
			"powershell.exe",
			[
				"-NoLogo",
				"-NoExit",
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				command,
			],
			{
				name: "xterm-256color",
				cols: 120,
				rows: 30,
				cwd: shellCwd,
				env: process.env,
				useConpty: true,
			},
		);
		runtime.pty.onData((data) => {
			if (
				runtime.attached &&
				mainWindow &&
				!mainWindow.isDestroyed()
			) {
				mainWindow.webContents.send("terminal:data", tab.tabId, data);
			} else {
				appendBacklog(runtime, data);
			}
		});
		runtime.pty.onExit(({ exitCode }) => {
			runtime.exited = true;
			runtime.exitCode = exitCode;
			runtime.pty = null;
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send("terminal:exit", tab.tabId, exitCode);
			}
		});
	} catch (error) {
		runtime.exited = true;
		runtime.exitCode = -1;
		appendBacklog(runtime, `\r\n\x1b[31m${String(error.message || error)}\x1b[0m\r\n`);
	}
	return runtime;
}

function addTab(command) {
	const cwd = normalizeCwd(command.cwd);
	const isSession = command.type === "open_session";
	if (isSession && !String(command.session_id || "").trim()) {
		throw new Error("A session ID is required.");
	}
	const tab = {
		tabId: crypto.randomUUID(),
		kind: isSession ? "session" : "pending_new_chat",
		sessionId: isSession ? String(command.session_id).trim() : "",
		cwd,
		title: String(command.title || "").trim() || (isSession ? "Codex Session" : "Codex New Chat"),
		model: String(command.model || "").trim(),
		createdAt: new Date().toISOString(),
	};
	workspace.tabs.push(tab);
	workspace.activeTabId = tab.tabId;
	commitWorkspace();
	focusWindow();
	return tab;
}

function closeTab(tabId) {
	const index = workspace.tabs.findIndex((tab) => tab.tabId === tabId);
	if (index < 0) {
		return false;
	}
	workspace.tabs.splice(index, 1);
	if (workspace.activeTabId === tabId) {
		const replacement = workspace.tabs[Math.min(index, workspace.tabs.length - 1)];
		workspace.activeTabId = replacement?.tabId || null;
	}
	commitWorkspace();
	const runtime = runtimes.get(tabId);
	runtimes.delete(tabId);
	runtime?.pty?.kill();
	return true;
}

function activateTab(tabId) {
	if (!workspace.tabs.some((tab) => tab.tabId === tabId)) {
		return false;
	}
	if (workspace.activeTabId !== tabId) {
		workspace.activeTabId = tabId;
		commitWorkspace();
	}
	return true;
}

function resolvePendingSessions() {
	const changed = resolvePendingTabs(workspace, codexHome);
	const titles = loadSessionTitles(path.join(codexHome, "session_index.jsonl"));
	for (const tab of workspace.tabs) {
		const currentTitle = titles.get(tab.sessionId);
		if (currentTitle && currentTitle !== tab.title) {
			tab.title = currentTitle;
			changed.value = true;
		}
	}
	if (changed.value) {
		commitWorkspace();
	}
}

function authorizeRequest(request) {
	return request.headers.authorization === `Bearer ${discoveryToken}`;
}

function sendJson(response, statusCode, body) {
	response.writeHead(statusCode, { "Content-Type": "application/json" });
	response.end(JSON.stringify(body));
}

function readJsonBody(request) {
	return new Promise((resolve, reject) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			body += chunk;
			if (body.length > MAX_COMMAND_BYTES) {
				reject(new Error("Command body is too large."));
				request.destroy();
			}
		});
		request.on("end", () => {
			try {
				resolve(JSON.parse(body || "{}"));
			} catch {
				reject(new Error("Command body is not valid JSON."));
			}
		});
		request.on("error", reject);
	});
}

function writeDiscoveryFile(port) {
	const payload = {
		version: 1,
		pid: process.pid,
		port,
		token: discoveryToken,
		startedAt: new Date().toISOString(),
	};
	fs.mkdirSync(path.dirname(discoveryFile), { recursive: true });
	const temporary = `${discoveryFile}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), "utf8");
	fs.renameSync(temporary, discoveryFile);
}

function removeDiscoveryFile() {
	try {
		const current = JSON.parse(fs.readFileSync(discoveryFile, "utf8"));
		if (current.pid === process.pid) {
			fs.unlinkSync(discoveryFile);
		}
	} catch {
		// A stale or already removed discovery file requires no cleanup.
	}
}

function startCommandServer() {
	discoveryToken = crypto.randomBytes(32).toString("hex");
	commandServer = http.createServer(async (request, response) => {
		if (!authorizeRequest(request)) {
			sendJson(response, 401, { ok: false, error: "Unauthorized." });
			return;
		}
		if (request.method === "GET" && request.url === "/health") {
			sendJson(response, 200, { ok: true, pid: process.pid });
			return;
		}
		if (
			process.env.CODEX_FE_INTEGRATION_TEST === "1" &&
			request.method === "POST" &&
			request.url === "/test/close-active"
		) {
			const closedTabId = workspace.activeTabId;
			sendJson(response, 200, {
				ok: closeTab(closedTabId),
				tab_id: closedTabId,
			});
			return;
		}
		if (
			process.env.CODEX_FE_INTEGRATION_TEST === "1" &&
			request.method === "POST" &&
			request.url === "/test/quit"
		) {
			sendJson(response, 200, { ok: true });
			setImmediate(() => mainWindow?.close());
			return;
		}
		if (request.method !== "POST" || request.url !== "/commands") {
			sendJson(response, 404, { ok: false, error: "Unknown endpoint." });
			return;
		}
		try {
			const command = await readJsonBody(request);
			if (!["open_session", "new_chat"].includes(command.type)) {
				throw new Error(`Unsupported command type: ${command.type}`);
			}
			const tab = addTab(command);
			sendJson(response, 200, { ok: true, tab_id: tab.tabId });
		} catch (error) {
			sendJson(response, 400, { ok: false, error: String(error.message || error) });
		}
	});
	commandServer.listen(0, "127.0.0.1", () => {
		writeDiscoveryFile(commandServer.address().port);
	});
}

ipcMain.handle("host:ready", () => publicWorkspace());

ipcMain.handle("terminal:attach", (_event, tabId) => {
	const tab = workspace.tabs.find((candidate) => candidate.tabId === tabId);
	if (!tab) {
		throw new Error("Tab no longer exists.");
	}
	const runtime = spawnTab(tab);
	const backlog = runtime.backlog;
	runtime.backlog = "";
	runtime.attached = true;
	return {
		backlog,
		exited: runtime.exited,
		exitCode: runtime.exitCode,
	};
});

ipcMain.on("terminal:input", (_event, tabId, data) => {
	runtimes.get(tabId)?.pty?.write(data);
});

ipcMain.on("terminal:resize", (_event, tabId, cols, rows) => {
	if (cols > 0 && rows > 0) {
		runtimes.get(tabId)?.pty?.resize(cols, rows);
	}
});

ipcMain.handle("tab:activate", (_event, tabId) => activateTab(tabId));
ipcMain.handle("tab:close", (_event, tabId) => closeTab(tabId));
ipcMain.handle("clipboard:write-text", (_event, text) => {
	clipboard.writeText(String(text || ""));
	return true;
});

const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) {
	app.quit();
} else {
	app.on("second-instance", focusWindow);
	app.whenReady().then(() => {
		codexHome = resolveCodexHome();
		fs.mkdirSync(codexHome, { recursive: true });
		archiveLegacyState(codexHome);
		workspaceStore = new WorkspaceStore(path.join(codexHome, "codex-fe-tabs.json"));
		workspace = workspaceStore.load();
		discoveryFile = path.join(codexHome, "codex-fe-host.json");
		createWindow();
		startCommandServer();
		resolvePendingSessions();
		resolverTimer = setInterval(resolvePendingSessions, 2000);
	});
}

app.on("before-quit", () => {
	shuttingDown = true;
	if (resolverTimer) {
		clearInterval(resolverTimer);
	}
	removeDiscoveryFile();
	commandServer?.close();
	for (const runtime of runtimes.values()) {
		runtime.pty?.kill();
	}
	runtimes.clear();
});

app.on("window-all-closed", () => {
	if (!shuttingDown) {
		app.quit();
	}
});
