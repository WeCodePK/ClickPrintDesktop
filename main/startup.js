const { app } = require("electron");
const store = require("./store");

// "Start ClickPrint when I sign in" — a Windows login item that relaunches the
// app straight into the tray. The window is only shown once the operator
// actually opens the app (tray click / relaunching the shortcut), so a login
// launch quietly restores the jobs stream and the print engine in the
// background.

// Passed to the login-item launch so the first window starts hidden.
const HIDDEN_FLAG = "--hidden";
const STORE_KEY = "openAtLogin";

// Writing a login item in development would point the OS at the dev electron
// binary inside node_modules, so the registry entry is only written for a
// packaged install. The preference itself still round-trips through the store
// in dev, which keeps the settings toggle honest while developing.
function loginItemOptions(openAtLogin) {
	return { openAtLogin, path: process.execPath, args: [HIDDEN_FLAG] };
}

function isEnabled() {
	if (!app.isPackaged) return store.get(STORE_KEY) !== false;
	return !!app.getLoginItemSettings(loginItemOptions(true)).openAtLogin;
}

function setEnabled(enabled) {
	store.set(STORE_KEY, !!enabled);
	if (app.isPackaged) app.setLoginItemSettings(loginItemOptions(!!enabled));
	return isEnabled();
}

// Runs once on startup. A fresh install opts in — an unattended shop machine
// should come back up printing after a reboot without anyone launching the app.
// Re-applying an existing preference also refreshes the registered executable
// path, which matters after a reinstall into a different directory.
function initLoginItem() {
	const preference = store.get(STORE_KEY);
	setEnabled(preference === undefined ? true : preference);
	console.log(`[Startup] open at login: ${isEnabled()}`);
}

// True when the OS (or a shortcut carrying --hidden) started this process at
// login, in which case no window is shown until the operator opens the app.
function startedHidden() {
	return process.argv.includes(HIDDEN_FLAG) || !!app.getLoginItemSettings().wasOpenedAtLogin;
}

module.exports = { initLoginItem, isEnabled, setEnabled, startedHidden };
