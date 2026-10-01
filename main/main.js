const path = require('path');
const { registerIpcHandlers } = require('./ipc');
const { registerFileSchemePrivileges, registerFileProtocol, clearProofCache, clearLegacyFileCache } = require('./files');
const { loadPersistedAuth, getAuth } = require('./state');
const { startOfflineWatcher } = require('./printers');
const { initLoginItem, startedHidden } = require('./startup');
const { initUpdater } = require('./updater');
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require('electron');

// The app lives in the tray and keeps printing while its window is hidden, so a
// second launch must hand off to the running instance rather than start a rival
// one (two SSE streams / print engines would double-print). The loser exits;
// the winner surfaces its window in the "second-instance" handler below.
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();

// Privileged scheme registration must happen before the app is ready.
registerFileSchemePrivileges();

let window = null;
let tray = null;
// Set when the window was created hidden (login launch) and hasn't been shown
// yet, so its first appearance still gets the layout ready-to-show would have
// given it.
let needsInitialLayout = false;

// ── Window layout ────────────────────────────────────────────────────────────
// The auth screens (phone number, OTP, shop picker) use a compact window — the
// window's minimum size — centred on the monitor; everything past login uses it
// maximized. The layout is applied only when the mode CHANGES (entering the auth
// screens, or leaving them), so an operator who maximizes the login window keeps
// that until the next time they reach it (logout, next launch).
const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;
let windowMode = null; // "auth" | "app"

// A saved session with a chosen shop skips the auth screens (see App.jsx).
const initialWindowMode = () => {
	const auth = getAuth();
	return auth?.token && auth?.shopId ? "app" : "auth";
};

function applyWindowMode(mode, { force = false } = {}) {
	if (!window || window.isDestroyed()) return;
	if (mode === windowMode && !force) return;
	windowMode = mode;
	if (mode === "auth") {
		if (window.isFullScreen()) return; // the operator's own choice
		if (window.isMaximized()) window.unmaximize();
		window.setSize(MIN_WIDTH, MIN_HEIGHT);
		window.center();
	} else {
		window.maximize();
	}
}

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
	if (needsInitialLayout) {
		applyWindowMode(windowMode || initialWindowMode(), { force: true });
		needsInitialLayout = false;
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
			label: 'Exit',
			click: () => {
				app.isQuitting = true;
				app.quit();
			}
		}
	]));
}

function createTray() {
	const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.ico'));
	tray = new Tray(icon);

	tray.setToolTip('ClickPrint');
	refreshTrayMenu();

	tray.on('click', showWindow);
}

function createWindow(startHidden) {
	window = new BrowserWindow({
		show: false,
		minWidth: MIN_WIDTH,
		minHeight: MIN_HEIGHT,
		frame: false,
		backgroundColor: "#F7F8FA",
		icon: path.join(__dirname, "..", "assets", "icon.ico"),
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			// No `plugins`: previews are rendered with pdf.js, so this window never
			// embeds Chromium's PDF viewer. Print windows enable it for themselves.
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

	// Links that open a new window (target="_blank", e.g. the shop's location on
	// Google Maps) go to the default browser; the app never spawns a bare window.
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https:\/\//i.test(url)) shell.openExternal(url);
		return { action: "deny" };
	});

	window.once("ready-to-show", () => {
		// A login launch loads the renderer (so the print engine and its UI state
		// are warm) but never flashes a window — the operator opens it from the tray.
		if (startHidden) {
			console.log("[Main] started at login — staying in the tray");
			needsInitialLayout = true;
			return;
		}
		applyWindowMode(windowMode || initialWindowMode(), { force: true });
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
// The renderer reports which part of the app is showing: "auth" or "app".
ipcMain.on("window:set-mode", (_event, mode) => {
	if (mode !== "auth" && mode !== "app") return;
	// Before the window's first show just record it; ready-to-show / showWindow
	// lay the window out.
	if (!window?.isVisible() && needsInitialLayout) {
		windowMode = mode;
		return;
	}
	applyWindowMode(mode);
});
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
	// Payment proofs are re-downloaded with the jobs they belong to, so last
	// session's cache is never needed — and clearing it is what keeps the
	// directory from growing (see clearProofCache).
	clearProofCache();
	// Job files now live in per-job folders; drop the old flat cache.
	clearLegacyFileCache();
	createWindow(startedHidden());
	createTray();
	// Warm the printer offline-state cache and keep it fresh in the background so
	// listing printers never blocks on a PowerShell spawn.
	startOfflineWatcher();
	// Checks, downloads and installs on its own — see updater.js.
	initUpdater({ getMainWindow: () => window });
});

// Deliberately empty: the app is a tray resident, so a closed (hidden) window
// must not end the process. Quitting goes through the tray's Exit item.
app.on("window-all-closed", () => {});
