const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
	const listener = (_event, ...args) => callback(...args);
	ipcRenderer.on(channel, listener);
	return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("hostAPI", {
	ready: () => ipcRenderer.invoke("host:ready"),
	attach: (tabId) => ipcRenderer.invoke("terminal:attach", tabId),
	input: (tabId, data) => ipcRenderer.send("terminal:input", tabId, data),
	resize: (tabId, cols, rows) =>
		ipcRenderer.send("terminal:resize", tabId, cols, rows),
	activateTab: (tabId) => ipcRenderer.invoke("tab:activate", tabId),
	closeTab: (tabId) => ipcRenderer.invoke("tab:close", tabId),
	copyText: (text) => ipcRenderer.invoke("clipboard:write-text", text),
	onWorkspaceChanged: (callback) => subscribe("workspace:changed", callback),
	onData: (callback) => subscribe("terminal:data", callback),
	onExit: (callback) => subscribe("terminal:exit", callback),
});
