const path = require('path');
const { registerIpcHandlers } = require('./ipc');
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');

let window = null;
let tray = null;

function createTray() {
	const icon = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.ico'));
	tray = new Tray(icon);

	tray.setToolTip('Your App Name');
	tray.setContextMenu(Menu.buildFromTemplate([
		{
			label: 'Exit',
			click: () => {
				app.isQuitting = true;
				app.quit();
			}
		}
	]));

	tray.on('click', () => {
		window?.show();
		window?.focus();
	});
}

function createWindow() {
	window = new BrowserWindow({
		show: false,
		minWidth: 900,
		minHeight: 600,
		frame: false,
		backgroundColor: "#F7F8FA",
		icon: path.join(__dirname, "assets", "icon.png"),
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
		},
	});

	window.on("close", (event) => {
		if (!app.isQuitting) {
			event.preventDefault();
			window.hide();
		}
	});

	window.on("closed", () => window = null);
	window.once("ready-to-show", () => window.show());

	app.isPackaged
	?	window.loadFile(path.join(__dirname, "../renderer/dist/index.html"))
	: 	window.loadURL("http://localhost:3001");
}

registerIpcHandlers();

ipcMain.on("window:close", () => {
	// Treat the IPC close (custom titlebar ✕ button) the same as the native close
	if (!app.isQuitting) {
		window?.hide();
	} else {
		window?.close();
	}
});
ipcMain.on("window:minimize", () => window?.minimize());
ipcMain.on("window:maximize", () => window.isMaximized() ? window.unmaximize() : window?.maximize());

app.whenReady().then(() => {
	createWindow();
	createTray();
});

app.on("window-all-closed", (event) => event.preventDefault());