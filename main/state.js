const state = {
	auth: { token: null, profile: null, phoneNumber: null, shopId: null },
	jobs: [],
};

function getAuth() {
	return { ...state.auth };
}

function setAuth(updates) {
	Object.assign(state.auth, updates);
}

function clearAuth() {
	state.auth = { token: null, profile: null, phoneNumber: null, shopId: null };
	state.jobs = [];
}

function getJobs() {
	return state.jobs;
}

function setJobs(jobs) {
	state.jobs = jobs;
}

module.exports = { getAuth, setAuth, clearAuth, getJobs, setJobs };
