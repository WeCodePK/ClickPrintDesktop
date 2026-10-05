// The app-wide job status outbox (see statusOutbox.js), wired to the real
// backend, store and connectivity tracker.
const store = require("./store");
const api = require("./api");
const connectivity = require("./connectivity");
const { createStatusOutbox } = require("./statusOutbox");

// The job's current backend status: a string, null when the backend doesn't
// know the job, or undefined when it couldn't be asked (offline).
async function fetchJobStatus(jobId) {
	const active = await api.fetchJobs();
	if (!active.success || active.stale) return undefined;
	const job = (active.data || []).find((j) => j._id === jobId);
	if (job) return job.status;
	const history = await api.fetchHistory();
	if (!history.success || history.stale) return undefined;
	return (history.data || []).find((j) => j._id === jobId)?.status ?? null;
}

module.exports = createStatusOutbox({
	store,
	updateJobStatus: api.updateJobStatus,
	fetchJobStatus,
	isOnline: connectivity.isOnline,
});
