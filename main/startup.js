const { app } = require("electron");
const updateHandoff = require("./updateHandoff");

// ClickPrint always starts when the operator signs in to Windows: a login item
// relaunches the app straight into the tray, so an unattended shop machine
// comes back up printing after a reboot without anyone opening it. This is not
// configurable from within the app. The window is only shown once the operator
// actually opens the app (tray click / relaunching the shortcut).

// Passed to the login-item launch so the first window starts hidden.
const HIDDEN_FLAG = "--hidden";

// Runs once on startup. Re-registering every launch also repairs an entry the
// user removed through the OS, and refreshes the executable path after a
// reinstall into a different directory. Only written for a packaged install —
// in development it would point the OS at the dev electron binary.
function initLoginItem() {
	if (!app.isPackaged) return;
	app.setLoginItemSettings({ openAtLogin: true, path: process.execPath, args: [HIDDEN_FLAG] });
	console.log("[Startup] open at login registered");
}

// True when the OS (or a shortcut carrying --hidden) started this process at
// login, in which case no window is shown until the operator opens the app.
// Also true after an automatic update relaunched an app that was sitting in the
// tray — the installer starts it without --hidden, and an unattended machine
// shouldn't have a window pop up on every update.
function startedHidden() {
	return (
		process.argv.includes(HIDDEN_FLAG) ||
		!!app.getLoginItemSettings().wasOpenedAtLogin ||
		!!updateHandoff.take()?.hidden
	);
}

module.exports = { initLoginItem, startedHidden };
