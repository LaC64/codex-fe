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
			const value = readValue();
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
				CODEX_FE_INTEGRATION_TEST: "1",
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

	startHost();
	const firstDiscovery = await waitForDiscovery();
	const command = {
		type: "open_session",
		session_id: "integration-session",
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
	const secondResponse = await hostRequest(
		firstDiscovery,
		"POST",
		"/commands",
		{ ...command, cwd: path.join(testHome, "missing-folder") },
	);
	assert.equal(firstResponse.tab_id, secondResponse.tab_id);
	assert.equal(firstResponse.existing, false);
	assert.equal(secondResponse.existing, true);

	const firstState = await waitUntil("one unique persisted session tab", () => {
		if (!fs.existsSync(stateFile)) {
			return null;
		}
		const state = loadJson(stateFile);
		return state.tabs.length === 1 ? state : null;
	});
	assert.deepEqual(
		firstState.tabs.map((tab) => tab.sessionId),
		["integration-session"],
	);
	assert.equal(
		firstState.tabs.some((tab) => tab.sessionId === "must-not-import"),
		false,
	);
	assert.equal(
		fs.readdirSync(testHome).filter((name) => name.includes(".legacy-")).length,
		2,
	);
	const powerShellResponse = await hostRequest(
		firstDiscovery,
		"POST",
		"/test/click-add",
	);
	assert.equal(powerShellResponse.ok, true);
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
	const closeResponse = await hostRequest(
		firstDiscovery,
		"POST",
		"/test/close-active",
	);
	assert.equal(closeResponse.ok, true);
	assert.equal(closeResponse.tab_id, powerShellTabId);
	const stateAfterClose = await waitUntil("closed tab removal", () => {
		const state = loadJson(stateFile);
		return state.tabs.length === 1 ? state : null;
	});
	assert.deepEqual(
		stateAfterClose.tabs.map((tab) => tab.tabId),
		[firstResponse.tab_id],
	);

	await stopHost();
	assert.equal(fs.existsSync(discoveryFile), false);
	startHost();
	const secondDiscovery = await waitForDiscovery();
	const health = await hostRequest(secondDiscovery, "GET", "/health");
	assert.equal(health.ok, true);
	const restoredState = loadJson(stateFile);
	assert.deepEqual(
		restoredState.tabs.map((tab) => tab.tabId),
		stateAfterClose.tabs.map((tab) => tab.tabId),
	);
	console.log(
		`Integration passed: restored ${restoredState.tabs.length} tabs after host restart.`,
	);
}

run()
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
