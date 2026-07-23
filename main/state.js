const store = require("./store");

// `shopId`/`shopName` identify the shop the user chose at login (a user may own
// several). They stay null until a shop is selected — nothing shop-scoped (jobs
// SSE, shop fetch) should run before then. The choice is fixed for the session;
// changing shops requires logging out and back in.
const EMPTY_AUTH = { token: null, profile: null, phoneNumber: null, shopId: null, shopName: null };

const state = {
	auth: { ...EMPTY_AUTH },
	jobs: [],
};

function getAuth() {
	return { ...state.auth };
}

function setAuth(updates) {
	Object.assign(state.auth, updates);
	// Persist so the session survives an app restart (auto-login).
	store.set("auth", state.auth);
}

function clearAuth() {
	state.auth = { ...EMPTY_AUTH };
	state.jobs = [];
	store.remove("auth");
}

// Restores a previously-saved session into memory on startup. Must be called
// after the app is ready (store path resolves under userData).
function loadPersistedAuth() {
	const saved = store.get("auth");
	if (saved && saved.token) {
		Object.assign(state.auth, saved);
		console.log("[State] restored persisted session for shop", state.auth.shopId);
	}
	return getAuth();
}

function getJobs() {
	return state.jobs;
}

function setJobs(jobs) {
	state.jobs = jobs;
}

module.exports = { getAuth, setAuth, clearAuth, loadPersistedAuth, getJobs, setJobs };
