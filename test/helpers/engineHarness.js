// Drives the REAL print engine (main/printEngine.js) with its backend, printer,
// file and storage modules swapped for in-memory stand-ins, so every scheduling
// decision a test observes is the engine's own. Shared by the engine tests.
const path = require("node:path");
const Module = require("node:module");

const MAIN = path.join(__dirname, "..", "..", "main");

function loadEngine({ jobs = [], storeData = {} } = {}) {
	const state = {
		jobs,
		printed: [], // every document sent to a printer: { fileId, device, settings }
		statusCalls: [], // every backend status PATCH: { jobId, status }
		readyFiles: null, // null = every document downloaded; a Set = only these
		// true = prints stay in flight until the test calls one of pendingPrints.
		holdPrints: false,
		pendingPrints: [],
		statusListeners: [],
		store: new Map(Object.entries(storeData)),
		// false = the backend can't be reached: connectivity reports offline and
		// every status PATCH fails as a network error.
		online: true,
		// true = requests fail as network errors while connectivity still says
		// online (the link dropped and nobody has noticed yet).
		failRequests: false,
		netListeners: [],
	};
	// Flips the simulated connection and tells the engine, like connectivity.js.
	state.setOnline = (online) => {
		state.online = online;
		for (const fn of state.netListeners) fn();
	};

	const stubs = {
		api: {
			fetchServices: async () => ({ success: true, data: [] }),
			fetchPrinters: async () => ({ success: true, data: [] }),
			updateJobStatus: async (jobId, status) => {
				state.statusCalls.push({ jobId, status, online: state.online });
				if (!state.online || state.failRequests) return { success: false, kind: "network", offline: true, retryable: true };
				return { success: true };
			},
			markJobFailed: async () => ({ success: true }),
		},
		printers: { listPrinters: async () => [] },
		files: {
			isReady: (fileId) => !state.readyFiles || state.readyFiles.has(fileId),
			printAndVerify: (fileId, settings, device, name, { onPhase, onIdentified } = {}) => {
				state.printed.push({ fileId, device, settings });
				onPhase?.();
				onIdentified?.(`spool-${state.printed.length}`);
				if (state.holdPrints) {
					return new Promise((resolve) => state.pendingPrints.push(() => resolve({ outcome: "printed" })));
				}
				return Promise.resolve({ outcome: "printed" });
			},
			deleteJobFiles: async () => {},
			deleteJobProof: async () => {},
			addStatusListener: (fn) => state.statusListeners.push(fn),
		},
		spooler: { abortAll: () => {} },
		printerRegistry: {
			rebuild: () => {},
			reconcile: async () => {},
			hasAutoRoute: () => true,
			dropJob: () => {},
			choosePrinter: (settings, { overrideDevice } = {}) => ({ device: overrideDevice || "Printer A", reason: null }),
			loadOf: () => 0,
			enqueue: () => {},
			dequeue: () => {},
			setSpoolId: () => {},
			setChangeNotifier: () => {},
			reset: () => {},
		},
		store: {
			get: (key) => state.store.get(key),
			set: (key, value) => state.store.set(key, value),
			remove: (key) => state.store.delete(key),
		},
		state: { getJobs: () => state.jobs },
		connectivity: {
			isOnline: () => state.online,
			onChange: (fn) => state.netListeners.push(fn),
		},
	};
	// The REAL outbox, over the in-memory store and the stub backend above.
	const { createStatusOutbox } = require(path.join(MAIN, "statusOutbox.js"));
	stubs.outbox = createStatusOutbox({
		store: stubs.store,
		updateJobStatus: (jobId, status) => stubs.api.updateJobStatus(jobId, status),
		fetchJobStatus: async (jobId) => state.jobs.find((j) => j._id === jobId)?.status ?? null,
		isOnline: () => state.online,
		setTimer: () => null,
		clearTimer: () => {},
	});
	state.outbox = stubs.outbox;

	for (const [name, exports] of Object.entries(stubs)) {
		const file = path.join(MAIN, `${name}.js`);
		const mod = new Module(file);
		mod.filename = file;
		mod.loaded = true;
		mod.exports = exports;
		require.cache[file] = mod;
	}
	// A fresh engine per test — it keeps its state at module level.
	for (const name of ["printEngine", "jobRules", "fileSettings", "updateHandoff"]) delete require.cache[path.join(MAIN, `${name}.js`)];

	const engine = require(path.join(MAIN, "printEngine.js"));
	engine.init({ getMainWindow: () => null, onSnapshot: () => {}, onToast: () => {}, onJobsChanged: () => {} });
	return { engine, state };
}

// Lets the engine's async chains (status PATCH → spool → verify → complete) run out.
async function settle() {
	for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
}

module.exports = { loadEngine, settle };
