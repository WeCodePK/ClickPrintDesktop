const fs = require("fs");
const path = require("path");
const { app, ipcMain } = require("electron");
const { autoUpdater } = require("electron-updater");
const engine = require("./printEngine");
const updateHandoff = require("./updateHandoff");

// ─────────────────────────────────────────────────────────────────────────────
// Fully automatic updates. ClickPrint runs unattended — often nobody is at the
// machine — so an update never waits for a click:
//   1. a new release is found (on launch, then every CHECK_INTERVAL_MS) and
//      downloaded in the background;
//   2. once downloaded, the print engine is held: documents already at a
//      printer finish, nothing new starts (automated or manual);
//   3. as soon as nothing is printing, the engine's state is saved (see
//      updateHandoff) and the installer runs silently, relaunching the app;
//   4. the relaunched app restores that state — tray-hidden window, automated
//      printing on — and the queue is rebuilt from the backend.
// ─────────────────────────────────────────────────────────────────────────────

const CHECK_INTERVAL_MS = 10 * 60 * 1000;

autoUpdater.autoDownload = true;
// Fallback when the install can't run unattended ("blocked" below): it then
// happens the next time the app is closed.
autoUpdater.autoInstallOnAppQuit = true;

// state: 'idle' | 'checking' | 'downloading' | 'waiting' (for the current print
// to finish) | 'installing' | 'blocked' (downloaded, but installing needs an
// administrator). Kept here and replayed on demand (app:get-update-status) so
// a toast that mounts late — e.g. after login — still shows the current stage.
let status = { state: "idle", version: null, percent: 0 };
let getWindow = () => null;
let installStarted = false;

function setStatus(state, extra = {}) {
	status = { ...status, state, ...extra };
	const win = getWindow();
	if (win && !win.isDestroyed()) win.webContents.send("updater:status", status);
}

// Past this point a check could only clobber the state (and a failed one used
// to hide a finished download), so checks stop.
const settled = () => ["downloading", "waiting", "installing", "blocked"].includes(status.state);

function check() {
	if (settled()) return;
	autoUpdater.checkForUpdates().catch(() => {}); // reported via the "error" event
}

// The silent installer can only replace the app without a UAC prompt when it
// lives somewhere this user can write — a per-user install. A per-machine one
// (Program Files) would sit on an elevation prompt with the app already closed,
// leaving an unattended shop offline until someone clicks it.
function canInstallUnattended() {
	const probe = path.join(path.dirname(process.execPath), `.update-probe-${process.pid}`);
	try {
		fs.writeFileSync(probe, "");
		fs.unlinkSync(probe);
		return true;
	} catch {
		return false;
	}
}

async function installWhenIdle(version) {
	if (installStarted) return;
	installStarted = true;

	if (!canInstallUnattended()) {
		console.warn(`[Updater] ${version} downloaded, but the install folder isn't writable — needs an administrator; will install when the app is closed`);
		setStatus("blocked", { version });
		return;
	}

	setStatus("waiting", { version });
	engine.holdForUpdate();
	await engine.whenNothingPrinting();

	console.log(`[Updater] printers idle — installing ${version}`);
	setStatus("installing", { version });
	const win = getWindow();
	updateHandoff.save({
		version,
		// Come back the way the operator left it: in the tray if that's where it was.
		hidden: !win || win.isDestroyed() || !win.isVisible(),
		engine: engine.exportUpdateState(),
	});
	// Silent (the "assisted" NSIS installer would otherwise show its wizard), and
	// relaunch afterwards — electron-updater only does that on its own for the
	// non-silent path. The brief delay lets the "installing" toast paint.
	setTimeout(() => autoUpdater.quitAndInstall(true, true), 1500);
}

autoUpdater.on("checking-for-update", () => setStatus("checking"));
autoUpdater.on("update-available", (info) => {
	console.log("[Updater] update available:", info.version);
	setStatus("downloading", { version: info.version, percent: 0, error: null });
});
autoUpdater.on("update-not-available", () => setStatus("idle"));
autoUpdater.on("download-progress", (p) => setStatus("downloading", { percent: Math.round(p.percent || 0) }));
autoUpdater.on("update-downloaded", (info) => {
	console.log(`[Updater] ${info.version} downloaded`);
	installWhenIdle(info.version);
});
autoUpdater.on("error", (err) => {
	console.error("[Updater] error:", err);
	// A failed check or download falls back to idle; the next check retries.
	// Never overrides a finished download.
	if (status.state === "checking" || status.state === "downloading") {
		setStatus("idle", { error: err?.message || String(err) });
	}
});

function initUpdater({ getMainWindow }) {
	getWindow = getMainWindow;
	ipcMain.handle("app:get-version", () => app.getVersion());
	ipcMain.handle("app:get-update-status", () => status);
	if (!app.isPackaged) return;
	check();
	setInterval(check, CHECK_INTERVAL_MS);
}

module.exports = { initUpdater };
