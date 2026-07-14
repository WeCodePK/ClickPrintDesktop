const path = require('path');
const { registerIpcHandlers } = require('./ipc');
const { registerFileSchemePrivileges, registerFileProtocol } = require('./files');
const { loadPersistedAuth } = require('./state');
const { startOfflineWatcher } = require('./printers');
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// Last known update-lifecycle state. Kept here and replayed to the renderer on
// demand (app:get-update-status) so a banner that mounts late — e.g. after the
// operator logs in — still reflects an already-downloaded update instead of
// missing the one-off "downloaded" event.
// state: 'idle' | 'checking' | 'downloading' | 'ready'
let updateStatus = { state: 'idle', version: null, percent: 0 };

function setUpdateStatus(state, extra = {}) {
	updateStatus = { ...updateStatus, state, ...extra };
	if (window && !window.isDestroyed()) {
		window.webContents.send('updater:status', updateStatus);
	}
}

autoUpdater.on('checking-for-update', () => setUpdateStatus('checking'));
autoUpdater.on('update-available', (info) => {
	console.log('Update available:', info.version);
	setUpdateStatus('downloading', { version: info.version, percent: 0 });
});
autoUpdater.on('update-not-available', () => setUpdateStatus('idle'));
autoUpdater.on('download-progress', (p) => setUpdateStatus('downloading', { percent: Math.round(p.percent || 0) }));
autoUpdater.on('update-downloaded', (info) => {
	console.log(`Update ${info.version} downloaded — ready to install on relaunch`);
	setUpdateStatus('ready', { version: info.version });
});
autoUpdater.on('error', (err) => {
	console.error('Auto-updater error:', err);
	// Fall back to idle; a later check can retry.
	setUpdateStatus('idle', { error: err?.message || String(err) });
});

// Let the renderer trigger a restart + install, read the version, or replay the
// current update status (for a banner that mounts after events already fired).
ipcMain.on('app:restart-to-update', () => autoUpdater.quitAndInstall());
ipcMain.handle('app:get-version', () => app.getVersion());
ipcMain.handle('app:get-update-status', () => updateStatus);

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
		icon: path.join(__dirname, "assets", "icon.ico"),
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
	loadPersistedAuth();
	registerFileProtocol();
	createWindow();
	createTray();
	// Warm the printer offline-state cache and keep it fresh in the background so
	// listing printers never blocks on a PowerShell spawn.
	startOfflineWatcher();
	if (app.isPackaged) {
		autoUpdater.checkForUpdates();
		// Re-check hourly so a long-running instance picks up new releases.
		setInterval(() => autoUpdater.checkForUpdates(), 60 * 60 * 1000);
	}
});

app.on("window-all-closed", () => app.quit());