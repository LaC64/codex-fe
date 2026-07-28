const tabsElement = document.getElementById("tabs");
const addTabElement = document.getElementById("tab-add");
const terminalsElement = document.getElementById("terminals");
const statusElement = document.getElementById("status");
const emptyElement = document.getElementById("empty");
const terminalViews = new Map();

let workspace = { tabs: [], activeTabId: null };

function createTerminalView(tab) {
	const panel = document.createElement("section");
	panel.className = "terminal-panel";
	panel.dataset.tabId = tab.tabId;
	terminalsElement.appendChild(panel);

	const terminal = new Terminal({
		cursorBlink: true,
		fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
		fontSize: 14,
		lineHeight: 1.12,
		scrollback: 10000,
		theme: {
			background: "#111111",
			foreground: "#e7e7e7",
			cursor: "#f28c28",
			cursorAccent: "#111111",
			selectionBackground: "#60401f",
			black: "#111111",
			brightBlack: "#777777",
			yellow: "#f28c28",
			brightYellow: "#ffad55",
		},
	});
	const fitAddon = new FitAddon.FitAddon();
	terminal.loadAddon(fitAddon);
	terminal.open(panel);
	terminal.onData((data) => window.hostAPI.input(tab.tabId, data));
	terminal.attachCustomKeyEventHandler((event) => {
		if (event.type !== "keydown" || !event.ctrlKey) {
			return true;
		}
		if (event.key.toLowerCase() === "c" && terminal.hasSelection()) {
			const selectedText = terminal.getSelection();
			window.hostAPI.copyText(selectedText).then(() => terminal.clearSelection());
			return false;
		}
		if (event.key.toLowerCase() === "v") {
			window.hostAPI.readText().then((text) => {
				if (text) {
					terminal.paste(text);
				}
			});
			return false;
		}
		if (event.key.toLowerCase() === "w") {
			window.hostAPI.closeTab(tab.tabId);
			return false;
		}
		if (event.key === "Tab") {
			cycleTab(event.shiftKey ? -1 : 1);
			return false;
		}
		return true;
	});

	const view = { tab, panel, terminal, fitAddon, attached: false, exited: false };
	terminalViews.set(tab.tabId, view);
	window.hostAPI
		.attach(tab.tabId)
		.then((state) => {
			view.attached = true;
			if (state.backlog) {
				terminal.write(state.backlog);
			}
			if (state.exited) {
				markExited(tab.tabId, state.exitCode);
			}
			fitActiveTerminal();
		})
		.catch((error) => {
			terminal.write(`\x1b[31m${String(error)}\x1b[0m\r\n`);
		});
	return view;
}

function destroyTerminalView(tabId) {
	const view = terminalViews.get(tabId);
	if (!view) {
		return;
	}
	view.terminal.dispose();
	view.panel.remove();
	terminalViews.delete(tabId);
}

function renderTabs() {
	tabsElement.replaceChildren();
	for (const tab of workspace.tabs) {
		const tabButton = document.createElement("div");
		tabButton.className = `tab${tab.tabId === workspace.activeTabId ? " active" : ""}`;
		tabButton.title = `${tab.title}\n${tab.cwd}`;
		tabButton.dataset.tabId = tab.tabId;
		tabButton.tabIndex = 0;
		tabButton.setAttribute("role", "tab");

		const mark = document.createElement("span");
		mark.className = "shell-mark";
		mark.textContent = "PS";
		const title = document.createElement("span");
		title.className = "tab-title";
		title.textContent = tab.title;
		const close = document.createElement("button");
		close.type = "button";
		close.className = "tab-close";
		close.title = "Close tab";
		close.setAttribute("aria-label", `Close ${tab.title}`);
		close.textContent = "\u00d7";

		tabButton.append(mark, title, close);
		tabButton.addEventListener("click", () => window.hostAPI.activateTab(tab.tabId));
		tabButton.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				window.hostAPI.activateTab(tab.tabId);
			}
		});
		tabButton.addEventListener("auxclick", (event) => {
			if (event.button === 1) {
				window.hostAPI.closeTab(tab.tabId);
			}
		});
		close.addEventListener("click", (event) => {
			event.stopPropagation();
			window.hostAPI.closeTab(tab.tabId);
		});
		tabsElement.appendChild(tabButton);
	}
}

function syncWorkspace(nextWorkspace) {
	workspace = nextWorkspace;
	const liveIds = new Set(workspace.tabs.map((tab) => tab.tabId));
	for (const tabId of terminalViews.keys()) {
		if (!liveIds.has(tabId)) {
			destroyTerminalView(tabId);
		}
	}
	for (const tab of workspace.tabs) {
		const view = terminalViews.get(tab.tabId) || createTerminalView(tab);
		view.tab = tab;
		view.panel.classList.toggle("active", tab.tabId === workspace.activeTabId);
	}
	emptyElement.classList.toggle("hidden", workspace.tabs.length > 0);
	statusElement.textContent = `${workspace.tabs.length} tab${workspace.tabs.length === 1 ? "" : "s"}`;
	renderTabs();
	requestAnimationFrame(fitActiveTerminal);
}

function fitActiveTerminal() {
	const view = terminalViews.get(workspace.activeTabId);
	if (!view) {
		return;
	}
	view.fitAddon.fit();
	if (view.attached) {
		window.hostAPI.resize(
			workspace.activeTabId,
			view.terminal.cols,
			view.terminal.rows,
		);
	}
	view.terminal.focus();
}

function cycleTab(offset) {
	if (workspace.tabs.length < 2) {
		return;
	}
	const index = workspace.tabs.findIndex((tab) => tab.tabId === workspace.activeTabId);
	const target = (index + offset + workspace.tabs.length) % workspace.tabs.length;
	window.hostAPI.activateTab(workspace.tabs[target].tabId);
}

function markExited(tabId, exitCode) {
	const view = terminalViews.get(tabId);
	if (!view || view.exited) {
		return;
	}
	view.exited = true;
	view.terminal.write(
		`\r\n\x1b[38;2;242;140;40m[PowerShell exited with code ${exitCode}]\x1b[0m\r\n`,
	);
}

window.hostAPI.onWorkspaceChanged(syncWorkspace);
window.hostAPI.onData((tabId, data) => terminalViews.get(tabId)?.terminal.write(data));
window.hostAPI.onExit(markExited);
addTabElement.addEventListener("click", () => window.hostAPI.newPowerShellTab());
new ResizeObserver(fitActiveTerminal).observe(terminalsElement);

window.hostAPI
	.ready()
	.then(syncWorkspace)
	.catch((error) => {
		statusElement.textContent = "Host failed";
		emptyElement.textContent = String(error);
	});
