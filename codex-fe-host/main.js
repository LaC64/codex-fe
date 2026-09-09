const { app, BrowserWindow, clipboard, ipcMain } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const pty = require("node-pty");
const {
	MAX_CLOSED_TABS,
	archiveLegacyState,
	createEmptyWorkspace,
	tabsShareIdentity,
	WorkspaceStore,
} = require("./workspace-store");
const {
	loadSessionTitles,
	resolvePendingTabs,
} = require("./session-resolver");
const {
	consumeExitMarkers,
	flushMarkerRemainder,
} = require("./runtime-output");

const CODEX_LAUNCH_ARGS = [
	"--dangerously-bypass-approvals-and-sandbox",
	"--no-alt-screen",
];
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
let rendererLoaded = false;
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

function resolveCodexFePickerCommand() {
	const configured = String(process.env.CODEX_FE_PICKER_COMMAND || "").trim();
	if (configured) {
		return configured;
	}
	const bundledCommand = path.resolve(__dirname, "..", "codex-fe.cmd");
	return fs.existsSync(bundledCommand)
		? `& ${quotePowerShell(bundledCommand)}`
		: "codex-fe";
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

function makePowerShellCommand(tab, exitToken) {
	const codexExecutable = resolveCodexExecutable();
	const title = quotePowerShell(tab.title || "Codex");
	const cwd = quotePowerShell(tab.cwd);
	const executable = quotePowerShell(codexExecutable);
	const args =
		tab.kind === "session" && tab.sessionId
			? ["-C", tab.cwd, "resume", tab.sessionId, ...CODEX_LAUNCH_ARGS]
			: ["-C", tab.cwd, ...CODEX_LAUNCH_ARGS];
	const argsList = args.map(quotePowerShell).join(", ");
	return [
		`$Host.UI.RawUI.WindowTitle = ${title}`,
		`Set-Location -LiteralPath ${cwd}`,
		`$codexExecutable = ${executable}`,
		`$codexArgs = @(${argsList})`,
		"& $codexExecutable @codexArgs",
		`[Console]::Write(([char]27) + ']9;codex-fe-exit=${exitToken}' + ([char]7))`,
	].join("; ");
}

function createWindow() {
	rendererLoaded = false;
	mainWindow = new BrowserWindow({
		show: false,
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
	mainWindow.on("maximize", () => persistWindowMaximized(true));
	mainWindow.on("unmaximize", () => persistWindowMaximized(false));
	mainWindow.on("close", () => {
		persistWindowMaximized(mainWindow.isMaximized());
	});
	if (workspace.windowState.maximized) {
		mainWindow.maximize();
	}
	mainWindow.once("ready-to-show", () => {
		mainWindow.show();
	});
	mainWindow.webContents.once("did-finish-load", () => {
		rendererLoaded = true;
	});
	mainWindow.loadFile("renderer/index.html");
	mainWindow.on("closed", () => {
		rendererLoaded = false;
		mainWindow = null;
	});
}

function waitForRendererLoad() {
	if (rendererLoaded) {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		mainWindow.webContents.once("did-finish-load", resolve);
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

function saveWorkspace() {
	workspace.updatedAt = new Date().toISOString();
	workspaceStore.save(workspace);
}

function commitWorkspace() {
	saveWorkspace();
	notifyWorkspaceChanged();
}

function persistWindowMaximized(maximized) {
	if (workspace.windowState.maximized === maximized) {
		return;
	}
	workspace.windowState.maximized = maximized;
	saveWorkspace();
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

function emitRuntimeData(tabId, runtime, data) {
	if (!data) {
		return;
	}
	if (
		runtime.attached &&
		mainWindow &&
		!mainWindow.isDestroyed()
	) {
		mainWindow.webContents.send("terminal:data", tabId, data);
	} else {
		appendBacklog(runtime, data);
	}
}

function processRuntimeData(tabId, runtime, data) {
	const result = consumeExitMarkers(runtime, data, runtime.exitMarker);
	if (result.markerCount > 0) {
		runtime.codexRunning = false;
	}
	emitRuntimeData(tabId, runtime, result.visibleData);
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
		exitToken: crypto.randomBytes(16).toString("hex"),
		exitMarker: "",
		markerRemainder: "",
		codexRunning: false,
		codexLaunchCount: 0,
		pickerLaunchCount: 0,
	};
	runtime.exitMarker = `\x1b]9;codex-fe-exit=${runtime.exitToken}\x07`;
	runtimes.set(tab.tabId, runtime);

	try {
		const shellCwd = fs.existsSync(tab.cwd) ? tab.cwd : os.homedir();
		const shellArguments =
			tab.kind === "powershell"
				? ["-NoLogo"]
				: tab.kind === "picker"
					? [
							"-NoLogo",
							"-NoProfile",
							"-ExecutionPolicy",
							"Bypass",
							"-Command",
							resolveCodexFePickerCommand(),
						]
				: [
						"-NoLogo",
						"-NoExit",
						"-NoProfile",
						"-ExecutionPolicy",
						"Bypass",
						"-Command",
						fs.existsSync(tab.cwd)
							? makePowerShellCommand(tab, runtime.exitToken)
							: `Write-Host ${quotePowerShell(`Saved folder no longer exists: ${tab.cwd}`)} -ForegroundColor Red`,
					];
		if (tab.kind === "picker") {
			runtime.pickerLaunchCount = 1;
		} else if (tab.kind !== "powershell" && fs.existsSync(tab.cwd)) {
			runtime.codexRunning = true;
			runtime.codexLaunchCount = 1;
		}
		runtime.pty = pty.spawn(
			"powershell.exe",
			shellArguments,
			{
				name: "xterm-256color",
				cols: 120,
				rows: 30,
				cwd: shellCwd,
				env: process.env,
				useConpty: true,
			},
		);
		runtime.pty.onData((data) => processRuntimeData(tab.tabId, runtime, data));
		runtime.pty.onExit(({ exitCode }) => {
			emitRuntimeData(tab.tabId, runtime, flushMarkerRemainder(runtime));
			runtime.exited = true;
			runtime.exitCode = exitCode;
			runtime.pty = null;
			runtime.codexRunning = false;
			if (tab.kind === "picker" && !shuttingDown) {
				closeTab(tab.tabId, false);
				return;
			}
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

function launchSessionInRuntime(tab, runtime) {
	const command = makePowerShellCommand(tab, runtime.exitToken);
	runtime.codexRunning = true;
	runtime.codexLaunchCount += 1;
	try {
		runtime.pty.write(`${command}\r`);
	} catch (error) {
		runtime.codexRunning = false;
		runtime.codexLaunchCount -= 1;
		throw error;
	}
}

function ensureSessionRunning(tab) {
	const previousRuntime = runtimes.get(tab.tabId);
	if (!previousRuntime || previousRuntime.exited) {
		const wasAttached = previousRuntime?.attached || false;
		const runtime = spawnTab(tab);
		if (wasAttached) {
			runtime.attached = true;
			emitRuntimeData(tab.tabId, runtime, runtime.backlog);
			runtime.backlog = "";
		}
		return true;
	}
	if (!previousRuntime.codexRunning) {
		launchSessionInRuntime(tab, previousRuntime);
		return true;
	}
	return false;
}

function appendTab(tab) {
	workspace.closedTabs = workspace.closedTabs.filter(
		(closedTab) => !tabsShareIdentity(closedTab, tab),
	);
	workspace.tabs.push(tab);
	workspace.activeTabId = tab.tabId;
	commitWorkspace();
	focusWindow();
	return tab;
}

function addTab(command) {
	const isSession = command.type === "open_session";
	const sessionId = isSession ? String(command.session_id || "").trim() : "";
	if (isSession && !sessionId) {
		throw new Error("A session ID is required.");
	}
	const existingTab = isSession
		? workspace.tabs.find(
				(tab) => tab.kind === "session" && tab.sessionId === sessionId,
			)
		: null;
	if (existingTab) {
		const relaunched = ensureSessionRunning(existingTab);
		activateTab(existingTab.tabId);
		focusWindow();
		return { tab: existingTab, existing: true, relaunched };
	}
	const cwd = normalizeCwd(command.cwd);
	const tab = {
		tabId: crypto.randomUUID(),
		kind: isSession ? "session" : "pending_new_chat",
		sessionId,
		cwd,
		title: String(command.title || "").trim() || (isSession ? "Codex Session" : "Codex New Chat"),
		model: String(command.model || "").trim(),
		createdAt: new Date().toISOString(),
	};
	return { tab: appendTab(tab), existing: false, relaunched: false };
}

function addPowerShellTab(title = "PowerShell") {
	return appendTab({
		tabId: crypto.randomUUID(),
		kind: "powershell",
		sessionId: "",
		cwd: os.homedir(),
		title,
		model: "",
		createdAt: new Date().toISOString(),
	});
}

function addCodexFeTab() {
	return appendTab({
		tabId: crypto.randomUUID(),
		kind: "picker",
		sessionId: "",
		cwd: os.homedir(),
		title: "Codex-FE",
		model: "",
		createdAt: new Date().toISOString(),
	});
}

function rememberClosedTab(tab) {
	workspace.closedTabs = workspace.closedTabs.filter(
		(closedTab) => !tabsShareIdentity(closedTab, tab),
	);
	workspace.closedTabs.push({ ...tab });
	if (workspace.closedTabs.length > MAX_CLOSED_TABS) {
		workspace.closedTabs = workspace.closedTabs.slice(-MAX_CLOSED_TABS);
	}
}

function closeTab(tabId, remember = true) {
	const index = workspace.tabs.findIndex((tab) => tab.tabId === tabId);
	if (index < 0) {
		return false;
	}
	const [closedTab] = workspace.tabs.splice(index, 1);
	if (remember && closedTab.kind !== "picker") {
		rememberClosedTab(closedTab);
	}
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

function restoreLastClosedTab() {
	const tab = workspace.closedTabs.pop();
	if (!tab) {
		return null;
	}
	const existingTab = workspace.tabs.find((openTab) =>
		tabsShareIdentity(openTab, tab),
	);
	if (existingTab) {
		workspace.activeTabId = existingTab.tabId;
		commitWorkspace();
		focusWindow();
		return existingTab;
	}
	return appendTab(tab);
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

function reorderTab(tabId, targetTabId, placement) {
	if (!["before", "after"].includes(placement) || tabId === targetTabId) {
		return false;
	}
	const sourceIndex = workspace.tabs.findIndex((tab) => tab.tabId === tabId);
	const targetIndex = workspace.tabs.findIndex((tab) => tab.tabId === targetTabId);
	if (sourceIndex < 0 || targetIndex < 0) {
		return false;
	}
	const previousOrder = workspace.tabs.map((tab) => tab.tabId);
	const [tab] = workspace.tabs.splice(sourceIndex, 1);
	const adjustedTargetIndex = workspace.tabs.findIndex(
		(candidate) => candidate.tabId === targetTabId,
	);
	const insertionIndex =
		placement === "after" ? adjustedTargetIndex + 1 : adjustedTargetIndex;
	workspace.tabs.splice(insertionIndex, 0, tab);
	if (
		workspace.tabs.some(
			(candidate, index) => candidate.tabId !== previousOrder[index],
		)
	) {
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
			request.method === "GET" &&
			request.url.startsWith("/test/runtime")
		) {
			const requestUrl = new URL(request.url, "http://127.0.0.1");
			const runtime = runtimes.get(requestUrl.searchParams.get("tab_id"));
			sendJson(response, 200, {
				ok: Boolean(runtime),
				codex_running: runtime?.codexRunning ?? false,
				launch_count: runtime?.codexLaunchCount ?? 0,
				picker_launch_count: runtime?.pickerLaunchCount ?? 0,
			});
			return;
		}
		if (
			process.env.CODEX_FE_INTEGRATION_TEST === "1" &&
			request.method === "POST" &&
			request.url === "/test/restore-shortcut"
		) {
			await waitForRendererLoad();
			mainWindow.webContents.sendInputEvent({
				type: "keyDown",
				keyCode: "T",
				modifiers: ["control", "shift"],
			});
			mainWindow.webContents.sendInputEvent({
				type: "keyUp",
				keyCode: "T",
				modifiers: ["control", "shift"],
			});
			sendJson(response, 200, { ok: true });
			return;
		}
		if (
			process.env.CODEX_FE_INTEGRATION_TEST === "1" &&
			request.method === "POST" &&
			request.url === "/test/click-add"
		) {
			await waitForRendererLoad();
			const result = await mainWindow.webContents.executeJavaScript(`
				(() => {
					const button = document.getElementById("tab-add");
					if (!button) {
						return { clicked: false, tabGap: null };
					}
					const tabs = [...document.querySelectorAll(".tab")];
					const lastTab = tabs.at(-1);
					const tabGap = lastTab
						? Math.abs(
							button.getBoundingClientRect().left -
								lastTab.getBoundingClientRect().right
						)
						: null;
					const strip = button.parentElement;
					const probe = strip.cloneNode(true);
					probe.removeAttribute("id");
					probe.querySelectorAll("[id]").forEach((element) =>
						element.removeAttribute("id")
					);
					probe.style.cssText =
						"position:absolute;visibility:hidden;width:380px;" +
						"left:-10000px;top:0;flex:none;";
					const templateTab = probe.querySelector(".tab");
					for (let index = 0; index < 3; index += 1) {
						probe.insertBefore(
							templateTab.cloneNode(true),
							probe.querySelector(".tab-add")
						);
					}
					document.body.appendChild(probe);
					const wrapRows = new Set(
						[...probe.querySelectorAll(".tab, .tab-add")].map(
							(element) => element.offsetTop
						)
					).size;
					const horizontalOverflow =
						probe.scrollWidth > probe.clientWidth;
					const maxTabWidth = lastTab
						? getComputedStyle(lastTab).maxWidth
						: "";
					probe.remove();
					button.click();
					return {
						clicked: true,
						horizontalOverflow,
						maxTabWidth,
						tabGap,
						wrapRows,
					};
				})()
			`);
			sendJson(response, 200, {
				horizontal_overflow: result.horizontalOverflow,
				max_tab_width: result.maxTabWidth,
				ok: result.clicked,
				tab_gap: result.tabGap,
				wrap_rows: result.wrapRows,
			});
			return;
		}
		if (
			process.env.CODEX_FE_INTEGRATION_TEST === "1" &&
			request.method === "POST" &&
			request.url === "/test/click-picker"
		) {
			await waitForRendererLoad();
			const clicked = await mainWindow.webContents.executeJavaScript(`
				(() => {
					const button = document.getElementById("tab-picker");
					if (!button) {
						return false;
					}
					button.click();
					return true;
				})()
			`);
			sendJson(response, 200, { ok: clicked });
			return;
		}
		if (
			process.env.CODEX_FE_INTEGRATION_TEST === "1" &&
			request.method === "POST" &&
			request.url === "/test/drag-first-after-last"
		) {
			await waitForRendererLoad();
			const dragged = await mainWindow.webContents.executeJavaScript(`
				(() => {
					const tabs = [...document.querySelectorAll(".tab")];
					if (tabs.length < 2) {
						return false;
					}
					const source = tabs[0];
					const target = tabs.at(-1);
					const dataTransfer = new DataTransfer();
					const targetRect = target.getBoundingClientRect();
					source.dispatchEvent(new DragEvent("dragstart", {
						bubbles: true,
						dataTransfer,
					}));
					target.dispatchEvent(new DragEvent("dragover", {
						bubbles: true,
						clientX: targetRect.right - 1,
						dataTransfer,
					}));
					target.dispatchEvent(new DragEvent("drop", {
						bubbles: true,
						clientX: targetRect.right - 1,
						dataTransfer,
					}));
					source.dispatchEvent(new DragEvent("dragend", {
						bubbles: true,
						dataTransfer,
					}));
					return true;
				})()
			`);
			sendJson(response, 200, { ok: dragged });
			return;
		}
		if (
			process.env.CODEX_FE_INTEGRATION_TEST === "1" &&
			request.method === "GET" &&
			request.url === "/test/terminal-geometry"
		) {
			await waitForRendererLoad();
			const geometry = await mainWindow.webContents.executeJavaScript(`
				(() => {
					const panel = document.querySelector(".terminal-panel.active");
					const terminal = panel?.querySelector(".xterm");
					const screen = terminal?.querySelector(".xterm-screen");
					if (!panel || !terminal || !screen) {
						return { ready: false };
					}
					const panelStyle = getComputedStyle(panel);
					const terminalStyle = getComputedStyle(terminal);
					const terminalRect = terminal.getBoundingClientRect();
					const screenRect = screen.getBoundingClientRect();
					const paddingBottom = parseFloat(terminalStyle.paddingBottom);
					return {
						ready: true,
						panelPaddingBottom: parseFloat(panelStyle.paddingBottom),
						panelPaddingTop: parseFloat(panelStyle.paddingTop),
						screenBottomOverflow: Math.max(
							0,
							screenRect.bottom - (terminalRect.bottom - paddingBottom)
						),
						terminalPaddingBottom: paddingBottom,
						terminalPaddingTop: parseFloat(terminalStyle.paddingTop),
					};
				})()
			`);
			sendJson(response, 200, { ok: true, ...geometry });
			return;
		}
		if (
			process.env.CODEX_FE_INTEGRATION_TEST === "1" &&
			["GET", "POST"].includes(request.method) &&
			request.url === "/test/activity-indicator"
		) {
			await waitForRendererLoad();
			if (request.method === "POST") {
				mainWindow.webContents.send(
					"terminal:data",
					workspace.activeTabId,
					"",
				);
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			const indicator = await mainWindow.webContents.executeJavaScript(`
				(() => {
					const activeTab = document.querySelector(".tab.active");
					const mark = activeTab?.querySelector(".shell-mark");
					return {
						busy: activeTab?.getAttribute("aria-busy") === "true",
						text: mark?.textContent || "",
					};
				})()
			`);
			sendJson(response, 200, { ok: true, ...indicator });
			return;
		}
		if (
			process.env.CODEX_FE_INTEGRATION_TEST === "1" &&
			["GET", "POST"].includes(request.method) &&
			request.url === "/test/window-maximized"
		) {
			if (request.method === "POST") {
				mainWindow.maximize();
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			sendJson(response, 200, {
				ok: true,
				maximized: mainWindow.isMaximized(),
				persisted: workspace.windowState.maximized,
			});
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
			const result = addTab(command);
			sendJson(response, 200, {
				ok: true,
				tab_id: result.tab.tabId,
				existing: result.existing,
				relaunched: result.relaunched,
			});
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
ipcMain.handle("tab:new-powershell", () => addPowerShellTab().tabId);
ipcMain.handle("tab:new-picker", () => addCodexFeTab().tabId);
ipcMain.handle("tab:reorder", (_event, tabId, targetTabId, placement) =>
	reorderTab(tabId, targetTabId, placement),
);
ipcMain.handle("tab:restore-closed", () => restoreLastClosedTab()?.tabId || null);
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
		workspaceStore.save(workspace);
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
