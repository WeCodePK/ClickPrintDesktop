const path = require('path');
const { registerIpcHandlers } = require('./ipc');
const { registerFileSchemePrivileges, registerFileProtocol } = require('./files');
const { loadPersistedAuth } = require('./state');
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');

// Privileged scheme registration must happen before the app is ready.
registerFileSchemePrivileges();

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
			plugins: true, // enable Chromium's built-in PDF viewer for previews
			// Allow the renderer to play notification sounds without a per-event
			// user gesture (Chromium blocks programmatic audio by default).
			autoplayPolicy: "no-user-gesture-required",
		},
	});

	window.on("closed", () => window = null);
	window.once("ready-to-show", () => {
		window.maximize();
		window.show();
	});

	app.isPackaged
	?	window.loadFile(path.join(__dirname, "../renderer/dist/index.html"))
	: 	window.loadURL("http://localhost:3001");

	registerIpcHandlers(() => window);
}


ipcMain.on("window:close", () => {
	window?.close();
});
ipcMain.on("window:minimize", () => window?.minimize());
ipcMain.on("window:maximize", () => window.isMaximized() ? window.unmaximize() : window?.maximize());

app.whenReady().then(() => {
	// Restore any saved session before handlers register (they check for a token
	// to resume the live jobs sync on startup).
	loadPersistedAuth();
	registerFileProtocol();
	createWindow();
	createTray();
});

app.on("window-all-closed", () => app.quit());