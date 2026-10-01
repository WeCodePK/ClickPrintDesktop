const store = require("./store");

// State carried across an automatic update's relaunch. The outgoing process
// saves it just before quitAndInstall; the relaunched one reads it once. It is
// what lets an unattended machine come back exactly as it was — window hidden
// in the tray if it was, automated printing still on — with nobody there to
// answer a prompt.
//
// It is only trusted for a short while: if the install failed and the app is
// started by hand much later, the saved state may no longer describe reality.

const KEY = "updateHandoff";
const MAX_AGE_MS = 15 * 60 * 1000;

function save(data) {
	store.set(KEY, { ...data, savedAt: Date.now() });
}

// Read-and-clear, memoised for the life of the process so every consumer
// (startup, the print engine) sees the same handoff.
let _taken;
function take() {
	if (_taken === undefined) {
		const saved = store.get(KEY);
		if (saved !== undefined) store.remove(KEY);
		_taken = saved && typeof saved === "object" && Date.now() - (saved.savedAt || 0) < MAX_AGE_MS ? saved : null;
	}
	return _taken;
}

module.exports = { save, take };
