const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const pty = require("node-pty");

let mainWindow = null;
let nextTerminalId = 1;
const terminals = new Map();

function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1200,
		height: 760,
		minWidth: 720,
		minHeight: 420,
		backgroundColor: "#111111",
		title: "Codex-FE Terminal Prototype",
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
		for (const terminal of terminals.values()) {
			terminal.kill();
		}
		terminals.clear();
		mainWindow = null;
	});
}

ipcMain.handle("terminal:create", (_event, options = {}) => {
	const terminalId = String(nextTerminalId++);
	const terminal = pty.spawn("powershell.exe", ["-NoLogo"], {
		name: "xterm-256color",
		cols: Number(options.cols) || 120,
		rows: Number(options.rows) || 30,
		cwd: process.cwd(),
		env: process.env,
		useConpty: true,
	});

	terminals.set(terminalId, terminal);
	terminal.onData((data) => {
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("terminal:data", terminalId, data);
		}
	});
	terminal.onExit(({ exitCode }) => {
		terminals.delete(terminalId);
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("terminal:exit", terminalId, exitCode);
		}
	});

	return terminalId;
});

ipcMain.on("terminal:input", (_event, terminalId, data) => {
	terminals.get(terminalId)?.write(data);
});

ipcMain.on("terminal:resize", (_event, terminalId, cols, rows) => {
	if (cols > 0 && rows > 0) {
		terminals.get(terminalId)?.resize(cols, rows);
	}
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
