const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("terminalAPI", {
	create: (options) => ipcRenderer.invoke("terminal:create", options),
	input: (terminalId, data) => ipcRenderer.send("terminal:input", terminalId, data),
	resize: (terminalId, cols, rows) =>
		ipcRenderer.send("terminal:resize", terminalId, cols, rows),
	onData: (callback) => {
		const listener = (_event, terminalId, data) => callback(terminalId, data);
		ipcRenderer.on("terminal:data", listener);
		return () => ipcRenderer.removeListener("terminal:data", listener);
	},
	onExit: (callback) => {
		const listener = (_event, terminalId, exitCode) => callback(terminalId, exitCode);
		ipcRenderer.on("terminal:exit", listener);
		return () => ipcRenderer.removeListener("terminal:exit", listener);
	},
});
