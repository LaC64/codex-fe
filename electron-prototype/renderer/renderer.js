const terminalElement = document.getElementById("terminal");
const statusElement = document.getElementById("status");
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
terminal.open(terminalElement);
fitAddon.fit();

let terminalId = null;

window.terminalAPI.onData((sourceId, data) => {
	if (sourceId === terminalId) {
		terminal.write(data);
	}
});

window.terminalAPI.onExit((sourceId, exitCode) => {
	if (sourceId === terminalId) {
		statusElement.textContent = `PowerShell exited (${exitCode})`;
		terminal.write(`\r\n\x1b[38;2;242;140;40m[PowerShell exited with code ${exitCode}]\x1b[0m\r\n`);
	}
});

terminal.onData((data) => {
	if (terminalId) {
		window.terminalAPI.input(terminalId, data);
	}
});

const resizeTerminal = () => {
	fitAddon.fit();
	if (terminalId) {
		window.terminalAPI.resize(terminalId, terminal.cols, terminal.rows);
	}
};

new ResizeObserver(resizeTerminal).observe(terminalElement);

window.terminalAPI
	.create({ cols: terminal.cols, rows: terminal.rows })
	.then((createdId) => {
		terminalId = createdId;
		statusElement.textContent = "PowerShell · ConPTY";
		terminal.focus();
		resizeTerminal();
	})
	.catch((error) => {
		statusElement.textContent = "Failed to start PowerShell";
		terminal.write(`\x1b[31m${String(error)}\x1b[0m\r\n`);
	});
