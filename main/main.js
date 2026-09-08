const path = require('path');
const { registerIpcHandlers } = require('./ipc');
const { registerFileSchemePrivileges, registerFileProtocol } = require('./files');
const { loadPersistedAuth } = require('./state');
const { startOfflineWatcher } = require('./printers');
const { initLoginItem, isEnabled: isOpenAtLogin, setEnabled: setOpenAtLogin, startedHidden } = require('./startup');
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// The app lives in the tray and keeps printing while its window is hidden, so a
// second launch must hand off to the running instance rather than start a rival
// one (two SSE streams / print engines would double-print). The loser exits;
// the winner surfaces its window in the "second-instance" handler below.
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();

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

// Launch-at-login preference, surfaced in the Settings tab and the tray menu.
ipcMain.handle('app:get-open-at-login', () => isOpenAtLogin());
ipcMain.handle('app:set-open-at-login', (_event, enabled) => {
	const value = setOpenAtLogin(enabled);
	refreshTrayMenu();
	return value;
});

// Privileged scheme registration must happen before the app is ready.
registerFileSchemePrivileges();

let window = null;
let tray = null;
// Set when the window was created hidden (login launch) and hasn't been shown
// yet, so its first appearance still gets the maximized layout ready-to-show
// would have given it.
let needsInitialMaximize = false;

// Set on the way out (tray "Exit", an update relaunch, an OS shutdown) so the
// window's close handler stops intercepting and lets the app actually die.
app.isQuitting = false;
app.on('before-quit', () => { app.isQuitting = true; });

// Brings the app back from the tray: restore if minimized, show if hidden, focus
// either way. Used by the tray, a second launch, and macOS dock activation.
function showWindow() {
	if (!window || window.isDestroyed()) {
		createWindow(false);
		return;
	}
	if (needsInitialMaximize) {
		window.maximize();
		needsInitialMaximize = false;
	}
	if (window.isMinimized()) window.restore();
	window.show();
	window.focus();
}

function refreshTrayMenu() {
	if (!tray) return;
	tray.setContextMenu(Menu.buildFromTemplate([
		{
			label: 'Open ClickPrint',
			click: showWindow,
		},
		{ type: 'separator' },
		{
			label: 'Start when I sign in',
			type: 'checkbox',
			checked: isOpenAtLogin(),
			click: (item) => {
				setOpenAtLogin(item.checked);
				refreshTrayMenu();
			},
		},
		{ type: 'separator' },
		{
			label: 'Exit',
			click: () => {
				app.isQuitting = true;
				app.quit();
			}
		}
	]));
}

function createTray() {
	const icon = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.ico'));
	tray = new Tray(icon);

	tray.setToolTip('ClickPrint');
	refreshTrayMenu();

	tray.on('click', showWindow);
}

function createWindow(startHidden) {
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

	// Closing the window (title-bar X or Alt+F4) only hides it — jobs keep
	// streaming and printing in the tray. Only an explicit quit tears it down.
	window.on("close", (event) => {
		if (app.isQuitting) return;
		event.preventDefault();
		window.hide();
	});
	window.on("closed", () => window = null);
	window.once("ready-to-show", () => {
		// A login launch loads the renderer (so the print engine and its UI state
		// are warm) but never flashes a window — the operator opens it from the tray.
		if (startHidden) {
			console.log("[Main] started at login — staying in the tray");
			needsInitialMaximize = true;
			return;
		}
		window.maximize();
		window.show();
	});

	app.isPackaged
	?	window.loadFile(path.join(__dirname, "../renderer/dist/index.html"))
	: 	window.loadURL("http://localhost:3001");

	registerIpcHandlers(() => window);
}


ipcMain.on("window:close", () => {
	// Routed through close() so the handler above applies: hide to tray.
	window?.close();
});
ipcMain.on("window:minimize", () => window?.minimize());
ipcMain.on("window:maximize", () => window.isMaximized() ? window.unmaximize() : window?.maximize());

// A second launch (desktop shortcut while the app sits in the tray) surfaces the
// existing window instead of starting another instance.
app.on("second-instance", (_event, argv) => {
	// A login-launched second instance (same --hidden flag) shouldn't pop the
	// window open; anything else is the operator asking for the app.
	if (!argv.includes("--hidden")) showWindow();
});
app.on("activate", showWindow);

if (hasInstanceLock) app.whenReady().then(() => {
	loadPersistedAuth();
	initLoginItem();
	registerFileProtocol();
	createWindow(startedHidden());
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

// Deliberately empty: the app is a tray resident, so a closed (hidden) window
// must not end the process. Quitting goes through the tray's Exit item.
app.on("window-all-closed", () => {});
