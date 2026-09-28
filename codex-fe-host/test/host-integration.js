const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const hostDir = path.resolve(__dirname, "..");
const electronExecutable = path.join(
	hostDir,
	"node_modules",
	"electron",
	"dist",
	"electron.exe",
);
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fe-host-integration-"));
const discoveryFile = path.join(testHome, "codex-fe-host.json");
const stateFile = path.join(testHome, "codex-fe-tabs.json");
const stubExecutable = path.join(testHome, "codex-stub.cmd");
const claudeExecutable = path.join(testHome, "claude-stub.cmd");
const claudeStubScript = path.join(testHome, "claude-stub.js");
const launchLog = path.join(testHome, "claude-launches.jsonl");
let hostProcess = null;
let activeDiscovery = null;

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(description, readValue, timeoutMilliseconds = 20000) {
	const deadline = Date.now() + timeoutMilliseconds;
	let lastError = null;
	while (Date.now() < deadline) {
		try {
			const value = await readValue();
			if (value) {
				return value;
			}
		} catch (error) {
			lastError = error;
		}
		await delay(100);
	}
	throw new Error(
		`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`,
	);
}

function startHost() {
	hostProcess = spawn(
		electronExecutable,
		[
			`--user-data-dir=${path.join(testHome, "electron-user-data")}`,
			hostDir,
			"--codex-home",
			testHome,
		],
		{
			cwd: hostDir,
			env: {
				...process.env,
				CODEX_FE_CODEX_EXE: stubExecutable,
				CODEX_FE_CLAUDE_EXE: claudeExecutable,
				CODEX_FE_TEST_LAUNCH_LOG: launchLog,
				CODEX_FE_INTEGRATION_TEST: "1",
				CODEX_FE_PICKER_COMMAND:
					"Write-Output CODEX_FE_PICKER_STARTED; Start-Sleep -Milliseconds 1000",
			},
			stdio: "ignore",
			windowsHide: true,
		},
	);
	hostProcess.on("error", (error) => {
		throw error;
	});
	return hostProcess;
}

async function stopHost() {
	if (!hostProcess || hostProcess.exitCode !== null) {
		return;
	}
	const processToStop = hostProcess;
	const exited = new Promise((resolve) =>
		processToStop.once("exit", () => resolve(true)),
	);
	if (activeDiscovery) {
		await hostRequest(activeDiscovery, "POST", "/test/quit");
	} else {
		processToStop.kill();
	}
	const stoppedCleanly = await Promise.race([
		exited,
		delay(10000).then(() => false),
	]);
	if (!stoppedCleanly) {
		spawnSync(
			"taskkill.exe",
			["/pid", String(processToStop.pid), "/t", "/f"],
			{ stdio: "ignore", windowsHide: true },
		);
	}
	hostProcess = null;
	activeDiscovery = null;
	await delay(500);
	if (!stoppedCleanly) {
		throw new Error(`Electron host ${processToStop.pid} did not stop cleanly.`);
	}
}

function loadJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

async function waitForDiscovery() {
	activeDiscovery = await waitUntil("host discovery", () => {
		if (!fs.existsSync(discoveryFile)) {
			return null;
		}
		const discovery = loadJson(discoveryFile);
		return discovery.port && discovery.token && discovery.pid ? discovery : null;
	});
	return activeDiscovery;
}

function hostRequest(discovery, method, route, body = null) {
	return new Promise((resolve, reject) => {
		const request = http.request(
			{
				hostname: "127.0.0.1",
				port: discovery.port,
				path: route,
				method,
				headers: {
					Authorization: `Bearer ${discovery.token}`,
					"Content-Type": "application/json",
				},
			},
			(response) => {
				let responseBody = "";
				response.setEncoding("utf8");
				response.on("data", (chunk) => {
					responseBody += chunk;
				});
				response.on("end", () => {
					try {
						const result = JSON.parse(responseBody);
						if (response.statusCode >= 400) {
							reject(new Error(result.error || `HTTP ${response.statusCode}`));
							return;
						}
						resolve(result);
					} catch (error) {
						reject(error);
					}
				});
			},
		);
		request.on("error", reject);
		if (body) {
			request.write(JSON.stringify(body));
		}
		request.end();
	});
}

async function run() {
	assert.equal(process.platform, "win32", "The ConPTY integration test requires Windows.");
	assert.ok(fs.existsSync(electronExecutable), "Electron is not installed.");

	fs.writeFileSync(
		path.join(testHome, "codex-fe-workspace.json"),
		JSON.stringify({ tabs: [{ id: "must-not-import" }] }),
	);
	fs.writeFileSync(
		path.join(testHome, "codex-fe-dashboard.json"),
		JSON.stringify({ legacy: true }),
	);
	fs.writeFileSync(stubExecutable, "@echo off\r\necho CODEX_STUB %*\r\n");
	fs.writeFileSync(claudeExecutable, `@echo off\r\nnode "${claudeStubScript}" %*\r\n`);
	fs.writeFileSync(claudeStubScript, `
		const fs = require('node:fs');
		const path = require('node:path');
		const args = process.argv.slice(2);
		fs.appendFileSync(process.env.CODEX_FE_TEST_LAUNCH_LOG,
			JSON.stringify({ args, cwd: process.cwd(), home: process.env.CLAUDE_CONFIG_DIR }) + '\\n');
		if (args.includes('--session-id')) {
			const sessionId = args[args.indexOf('--session-id') + 1];
			const directory = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'stub-project');
			fs.mkdirSync(directory, { recursive: true });
			fs.writeFileSync(path.join(directory, sessionId + '.jsonl'), [
				{ type: 'custom-title', sessionId, customTitle: 'Claude Stub Chat' },
				{ type: 'user', sessionId, cwd: process.cwd(), timestamp: new Date().toISOString(),
					message: { role: 'user', content: 'Integration prompt' } }
			].map(row => JSON.stringify(row) + '\\n').join(''));
		}
		console.log('CLAUDE_STUB ' + args.join(' '));
	`);

	startHost();
	const firstDiscovery = await waitForDiscovery();
	const command = {
		type: "open_session",
		session_id: "aaaaaaaa-1111-4222-8333-444444444444",
		title: "Integration Session",
		cwd: path.resolve(hostDir, ".."),
		model: "test-model",
	};
	const firstResponse = await hostRequest(
		firstDiscovery,
		"POST",
		"/commands",
		command,
	);
	const firstExitState = await waitUntil("first managed Codex exit", async () => {
		const state = await hostRequest(
			firstDiscovery,
			"GET",
			`/test/runtime?tab_id=${encodeURIComponent(firstResponse.tab_id)}`,
		);
		return state.ok && !state.agent_running && state.launch_count === 1
			? state
			: null;
	});
	assert.equal(firstExitState.launch_count, 1);
	const secondResponse = await hostRequest(
		firstDiscovery,
		"POST",
		"/commands",
		{ ...command, cwd: path.join(testHome, "missing-folder") },
	);
	assert.equal(firstResponse.tab_id, secondResponse.tab_id);
	assert.equal(firstResponse.existing, false);
	assert.equal(firstResponse.relaunched, false);
	assert.equal(secondResponse.existing, true);
	assert.equal(secondResponse.relaunched, true);
	const secondExitState = await waitUntil("second managed Codex exit", async () => {
		const state = await hostRequest(
			firstDiscovery,
			"GET",
			`/test/runtime?tab_id=${encodeURIComponent(firstResponse.tab_id)}`,
		);
		return !state.agent_running && state.launch_count === 2 ? state : null;
	});
	assert.equal(secondExitState.launch_count, 2);

	const firstState = await waitUntil("one unique persisted session tab", () => {
		if (!fs.existsSync(stateFile)) {
			return null;
		}
		const state = loadJson(stateFile);
		return state.tabs.length === 1 ? state : null;
	});
	assert.deepEqual(
		firstState.tabs.map((tab) => tab.sessionId),
		["aaaaaaaa-1111-4222-8333-444444444444"],
	);
	assert.equal(
		firstState.tabs.some((tab) => tab.sessionId === "must-not-import"),
		false,
	);
	assert.equal(
		fs.readdirSync(testHome).filter((name) => name.includes(".legacy-")).length,
		2,
	);
	const busyIndicator = await hostRequest(
		firstDiscovery,
		"POST",
		"/test/activity-indicator",
	);
	assert.equal(busyIndicator.busy, true);
	assert.notEqual(busyIndicator.text, "PS");
	await delay(1400);
	const idleIndicator = await hostRequest(
		firstDiscovery,
		"GET",
		"/test/activity-indicator",
	);
	assert.equal(idleIndicator.busy, false);
	assert.equal(idleIndicator.text, "CX");
	const powerShellResponse = await hostRequest(
		firstDiscovery,
		"POST",
		"/test/click-add",
	);
	assert.equal(powerShellResponse.ok, true);
	assert.ok(
		powerShellResponse.tab_gap <= 1,
		`Expected + button after final tab, found ${powerShellResponse.tab_gap}px gap.`,
	);
	assert.equal(powerShellResponse.max_tab_width, "520px");
	assert.ok(
		powerShellResponse.wrap_rows > 1,
		"Expected constrained tabs to wrap into multiple rows.",
	);
	assert.equal(powerShellResponse.horizontal_overflow, false);
	const stateWithPowerShell = await waitUntil("persisted PowerShell tab", () => {
		const state = loadJson(stateFile);
		return state.tabs.length === 2 ? state : null;
	});
	assert.deepEqual(
		stateWithPowerShell.tabs.map((tab) => tab.kind),
		["session", "powershell"],
	);
	assert.equal(stateWithPowerShell.tabs[1].title, "PowerShell");
	assert.equal(stateWithPowerShell.tabs[1].cwd, os.homedir());
	const powerShellTabId = stateWithPowerShell.tabs[1].tabId;
	const terminalGeometry = await waitUntil(
		"fitted PowerShell terminal geometry",
		async () => {
			const geometry = await hostRequest(
				firstDiscovery,
				"GET",
				"/test/terminal-geometry",
			);
			return geometry.ready ? geometry : null;
		},
	);
	assert.equal(terminalGeometry.panelPaddingTop, 0);
	assert.equal(terminalGeometry.panelPaddingBottom, 0);
	assert.equal(terminalGeometry.terminalPaddingTop, 9);
	assert.equal(terminalGeometry.terminalPaddingBottom, 9);
	assert.ok(
		terminalGeometry.screenBottomOverflow <= 1,
		`Expected the final terminal row to fit; overflow was ${terminalGeometry.screenBottomOverflow}px.`,
	);
	const dragResponse = await hostRequest(
		firstDiscovery,
		"POST",
		"/test/drag-first-after-last",
	);
	assert.equal(dragResponse.ok, true);
	const reorderedState = await waitUntil("persisted dragged tab order", () => {
		const state = loadJson(stateFile);
		return state.tabs[0]?.tabId === powerShellTabId ? state : null;
	});
	assert.deepEqual(
		reorderedState.tabs.map((tab) => tab.tabId),
		[powerShellTabId, firstResponse.tab_id],
	);
	assert.equal(reorderedState.activeTabId, powerShellTabId);
	const closeResponse = await hostRequest(
		firstDiscovery,
		"POST",
		"/test/close-active",
	);
	assert.equal(closeResponse.ok, true);
	assert.equal(closeResponse.tab_id, powerShellTabId);
	const stateAfterClose = await waitUntil("closed tab removal", () => {
		const state = loadJson(stateFile);
		return state.tabs.length === 1 && state.closedTabs.length === 1
			? state
			: null;
	});
	assert.deepEqual(
		stateAfterClose.tabs.map((tab) => tab.tabId),
		[firstResponse.tab_id],
	);
	assert.equal(stateAfterClose.closedTabs[0].tabId, powerShellTabId);

	const firstRestoreResponse = await hostRequest(
		firstDiscovery,
		"POST",
		"/test/restore-shortcut",
	);
	assert.equal(firstRestoreResponse.ok, true);
	const stateAfterFirstRestore = await waitUntil(
		"first Ctrl+Shift+T restoration",
		() => {
			const state = loadJson(stateFile);
			return state.tabs.length === 2 && state.closedTabs.length === 0
				? state
				: null;
		},
	);
	assert.equal(stateAfterFirstRestore.tabs.at(-1).tabId, powerShellTabId);

	const secondCloseResponse = await hostRequest(
		firstDiscovery,
		"POST",
		"/test/close-active",
	);
	assert.equal(secondCloseResponse.ok, true);
	assert.equal(secondCloseResponse.tab_id, powerShellTabId);
	const stateBeforeRestart = await waitUntil(
		"reclosed PowerShell tab persistence",
		() => {
			const state = loadJson(stateFile);
			return state.tabs.length === 1 && state.closedTabs.length === 1
				? state
				: null;
		},
	);
	const maximizeResponse = await hostRequest(
		firstDiscovery,
		"POST",
		"/test/window-maximized",
	);
	assert.equal(maximizeResponse.maximized, true);
	assert.equal(maximizeResponse.persisted, true);
	await waitUntil("persisted maximized window state", () => {
		const state = loadJson(stateFile);
		return state.windowState?.maximized === true ? state : null;
	});

	await stopHost();
	assert.equal(fs.existsSync(discoveryFile), false);
	startHost();
	const secondDiscovery = await waitForDiscovery();
	const health = await hostRequest(secondDiscovery, "GET", "/health");
	assert.equal(health.ok, true);
	const restoredWindowState = await hostRequest(
		secondDiscovery,
		"GET",
		"/test/window-maximized",
	);
	assert.equal(restoredWindowState.maximized, true);
	assert.equal(restoredWindowState.persisted, true);
	const restoredState = loadJson(stateFile);
	assert.deepEqual(
		restoredState.tabs.map((tab) => tab.tabId),
		stateBeforeRestart.tabs.map((tab) => tab.tabId),
	);
	assert.deepEqual(
		restoredState.closedTabs.map((tab) => tab.tabId),
		[powerShellTabId],
	);
	const secondRestoreResponse = await hostRequest(
		secondDiscovery,
		"POST",
		"/test/restore-shortcut",
	);
	assert.equal(secondRestoreResponse.ok, true);
	const finalState = await waitUntil(
		"persisted Ctrl+Shift+T restoration",
		() => {
			const state = loadJson(stateFile);
			return state.tabs.length === 2 && state.closedTabs.length === 0
				? state
				: null;
		},
	);
	assert.equal(finalState.tabs.at(-1).tabId, powerShellTabId);
	const pickerResponse = await hostRequest(
		secondDiscovery,
		"POST",
		"/test/click-picker",
	);
	assert.equal(pickerResponse.ok, true);
	const stateWithPicker = await waitUntil("Codex-FE picker tab", () => {
		const state = loadJson(stateFile);
		return state.tabs.length === 3 ? state : null;
	});
	const pickerTab = stateWithPicker.tabs.at(-1);
	assert.equal(pickerTab.kind, "picker");
	assert.equal(pickerTab.title, "Codex-FE");
	const pickerRuntime = await waitUntil("Codex-FE picker launch", async () => {
		const state = await hostRequest(
			secondDiscovery,
			"GET",
			`/test/runtime?tab_id=${encodeURIComponent(pickerTab.tabId)}`,
		);
		return state.picker_launch_count === 1 ? state : null;
	});
	assert.equal(pickerRuntime.picker_launch_count, 1);
	const stateAfterPickerExit = await waitUntil("transient picker removal", () => {
		const state = loadJson(stateFile);
		return state.tabs.length === 2 ? state : null;
	});
	assert.equal(
		stateAfterPickerExit.tabs.some((tab) => tab.tabId === pickerTab.tabId),
		false,
	);
	assert.equal(
		stateAfterPickerExit.closedTabs.some((tab) => tab.tabId === pickerTab.tabId),
		false,
	);

	const claudeCommand = {
		...command, provider: "claude", provider_home: path.join(testHome, "claude-config"),
		title: "Claude Integration",
	};
	const claudeResponse = await hostRequest(secondDiscovery, "POST", "/commands", claudeCommand);
	assert.notEqual(claudeResponse.tab_id, firstResponse.tab_id);
	await waitUntil("Claude exit to PowerShell", async () => {
		const runtime = await hostRequest(secondDiscovery, "GET", `/test/runtime?tab_id=${claudeResponse.tab_id}`);
		return runtime.ok && runtime.launch_count === 1 && !runtime.agent_running;
	});
	const reusedClaude = await hostRequest(secondDiscovery, "POST", "/commands", claudeCommand);
	assert.equal(reusedClaude.tab_id, claudeResponse.tab_id);
	assert.equal(reusedClaude.existing, true);
	assert.equal(reusedClaude.relaunched, true);
	const newClaude = await hostRequest(secondDiscovery, "POST", "/commands", {
		type: "new_chat", provider: "claude", provider_home: claudeCommand.provider_home,
		cwd: command.cwd,
	});
	const mixedState = await waitUntil("Claude new chat resolves its assigned UUID", () => {
		const state = loadJson(stateFile);
		const tab = state.tabs.find(tab => tab.tabId === newClaude.tab_id);
		return tab?.kind === "session" && tab.title === "Claude Stub Chat" ? state : null;
	});
	const newClaudeTab = mixedState.tabs.find(tab => tab.tabId === newClaude.tab_id);
	assert.match(newClaudeTab.sessionId, /^[0-9a-f-]{36}$/);
	const indicators = await hostRequest(secondDiscovery, "GET", "/test/tab-indicators");
	assert.deepEqual(indicators.indicators.map(({ provider, label, color }) => ({ provider, label, color })), [
		{ provider: "codex", label: "CX", color: "rgb(88, 166, 255)" },
		{ provider: "shell", label: "PS", color: "rgb(153, 153, 153)" },
		{ provider: "claude", label: "CL", color: "rgb(242, 140, 40)" },
		{ provider: "claude", label: "CL", color: "rgb(242, 140, 40)" },
	]);
	const closeClaude = await hostRequest(secondDiscovery, "POST", "/test/close-active");
	assert.equal(closeClaude.tab_id, newClaude.tab_id);
	await hostRequest(secondDiscovery, "POST", "/test/restore-shortcut");
	await waitUntil("closed Claude tab reopens by provider", () => {
		const state = loadJson(stateFile);
		return state.tabs.at(-1)?.tabId === newClaude.tab_id && state.closedTabs.length === 0;
	});
	await waitUntil("reopened Claude process completes before shutdown", async () => {
		const runtime = await hostRequest(secondDiscovery, "GET", `/test/runtime?tab_id=${newClaude.tab_id}`);
		return runtime.ok && runtime.launch_count === 1 && !runtime.agent_running;
	});
	await stopHost();
	startHost();
	const thirdDiscovery = await waitForDiscovery();
	const restoredMixed = loadJson(stateFile);
	assert.deepEqual(restoredMixed.tabs.map(tab => [tab.tabId, tab.provider, tab.sessionId]),
		mixedState.tabs.map(tab => [tab.tabId, tab.provider, tab.sessionId]));
	await waitUntil("restored Claude session launch", () => {
		const rows = fs.readFileSync(launchLog, "utf8").trim().split("\n").map(JSON.parse);
		return rows.filter(row => row.args.includes(newClaudeTab.sessionId)).length >= 3;
	});
	const launches = fs.readFileSync(launchLog, "utf8").trim().split("\n").map(JSON.parse);
	for (const launch of launches) {
		assert.ok(launch.args.includes("--dangerously-skip-permissions"));
		assert.ok(!launch.args.includes("--no-alt-screen"));
		assert.equal(launch.cwd.toLowerCase(), command.cwd.toLowerCase());
		assert.equal(launch.home, claudeCommand.provider_home);
	}
	assert.equal(launches.filter(row => row.args.includes("--session-id")).length, 1);
	assert.ok(launches.at(-1).args.includes("--resume"));
	const invalidProvider = await hostRequest(thirdDiscovery, "POST", "/commands", {
		...command, provider: "unsupported",
	}).then(() => null, error => error);
	assert.match(invalidProvider?.message || "", /Unsupported provider/);
	console.log(
		"Integration passed: mixed providers, colors, Claude new/resume, closed tabs, restart, reorder, and transient picker.",
	);
}

run()
	.catch((error) => {
		console.error("Claude launch diagnostics:", fs.existsSync(launchLog) ? fs.readFileSync(launchLog, "utf8") : "no launches");
		console.error("Workspace diagnostics:", fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : "no workspace");
		throw error;
	})
	.finally(async () => {
		try {
			await stopHost();
		} catch {
			// The test result reports clean-shutdown failures before best-effort cleanup.
		}
		fs.rmSync(testHome, { recursive: true, force: true });
	})
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
