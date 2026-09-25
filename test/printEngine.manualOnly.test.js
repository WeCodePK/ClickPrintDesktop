// Automated printing must never take a job that has additional comments or a
// payment proof. These drive the REAL print engine (main/printEngine.js); only
// its backend, printer, file and storage modules are swapped for in-memory
// stand-ins, so every scheduling decision below is the engine's own.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const MAIN = path.join(__dirname, "..", "main");

function loadEngine({ jobs = [], storeData = {} } = {}) {
	const state = {
		jobs,
		printed: [], // every document sent to a printer: { fileId, device }
		statusCalls: [], // every backend status PATCH: { jobId, status }
		readyFiles: null, // null = every document downloaded; a Set = only these
		statusListeners: [],
		store: new Map(Object.entries(storeData)),
	};

	const stubs = {
		api: {
			fetchServices: async () => ({ success: true, data: [] }),
			fetchPrinters: async () => ({ success: true, data: [] }),
			updateJobStatus: async (jobId, status) => {
				state.statusCalls.push({ jobId, status });
				return { success: true };
			},
			markJobFailed: async () => ({ success: true }),
		},
		printers: { listPrinters: async () => [] },
		files: {
			isReady: (fileId) => !state.readyFiles || state.readyFiles.has(fileId),
			printAndVerify: (fileId, settings, device, name, { onPhase, onIdentified } = {}) => {
				state.printed.push({ fileId, device });
				onPhase?.();
				onIdentified?.(`spool-${state.printed.length}`);
				return Promise.resolve({ outcome: "printed" });
			},
			savePdfCopy: async () => {},
			deleteJobFiles: async () => {},
			deleteJobProof: async () => {},
			addStatusListener: (fn) => state.statusListeners.push(fn),
		},
		spooler: { abortAll: () => {} },
		printerRegistry: {
			isPdfDevice: () => false,
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
	};

	for (const [name, exports] of Object.entries(stubs)) {
		const file = path.join(MAIN, `${name}.js`);
		const mod = new Module(file);
		mod.filename = file;
		mod.loaded = true;
		mod.exports = exports;
		require.cache[file] = mod;
	}
	// A fresh engine per test — it keeps its state at module level.
	for (const name of ["printEngine", "jobRules"]) delete require.cache[path.join(MAIN, `${name}.js`)];

	const engine = require(path.join(MAIN, "printEngine.js"));
	engine.init({ getMainWindow: () => null, onSnapshot: () => {}, onToast: () => {}, onJobsChanged: () => {} });
	return { engine, state };
}

// Lets the engine's async chains (status PATCH → spool → verify → complete) run out.
async function settle() {
	for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
}

const doc = (id) => ({ file: { _id: id, originalName: `${id}.pdf` }, settings: { pageType: "A4" } });
const job = (id, extra = {}, docIds = [`${id}-f1`]) => ({
	_id: id,
	status: "submitted",
	additionalComments: "", // the backend default
	files: docIds.map(doc),
	...extra,
});

const fixtures = () => [
	job("plain"),
	job("blank-comments", { additionalComments: "   " }),
	job("comments", { additionalComments: "Please staple each copy" }, ["comments-f1", "comments-f2"]),
	job("proof", { paymentProofFile: { _id: "pf1", name: "transfer.png" } }),
	job("proof-id", { paymentProofFile: "pf2" }),
	job("proof-unresolved", { paymentProofFile: null }),
	job("both", { additionalComments: "Urgent", paymentProofFile: { _id: "pf3", name: "t.png" } }),
];
const AUTO_IDS = ["blank-comments", "plain"];
const MANUAL_IDS = ["both", "comments", "proof", "proof-id", "proof-unresolved"];

const printedJobIds = (state) => [...new Set(state.printed.map((p) => p.fileId.replace(/-f\d+$/, "")))].sort();
const touched = (state, jobId) => state.statusCalls.some((c) => c.jobId === jobId);

test("enabling automated printing prints the ordinary backlog and never touches annotated jobs", async () => {
	const { engine, state } = loadEngine({ jobs: fixtures() });
	engine.start();
	engine.onJobsReconciled(state.jobs);
	await settle();
	assert.equal(state.printed.length, 0, "nothing prints before automated printing is on");

	engine.setAutoPrint(true);
	await settle();

	// Positive control: automated printing really is running.
	assert.deepEqual(printedJobIds(state), AUTO_IDS);
	for (const id of AUTO_IDS) {
		assert.ok(state.statusCalls.some((c) => c.jobId === id && c.status === "completed"), `${id} completed`);
	}
	// Annotated jobs: not printed, not moved to "printing", not even queued.
	const files = engine.getSnapshot().files;
	for (const id of MANUAL_IDS) {
		assert.ok(!touched(state, id), `${id} had its status changed`);
		assert.equal(files[id], undefined, `${id} has documents queued`);
	}
	engine.stop();
});

test("jobs arriving while automated printing is on: ordinary ones print, annotated ones don't", async () => {
	const { engine, state } = loadEngine({ jobs: [] });
	engine.start();
	engine.onJobsReconciled([]);
	engine.setAutoPrint(true);
	await settle();

	state.jobs = fixtures();
	engine.onJobsReconciled(state.jobs);
	await settle();

	assert.deepEqual(printedJobIds(state), AUTO_IDS);
	for (const id of MANUAL_IDS) assert.ok(!touched(state, id), `${id} had its status changed`);
	engine.stop();
});

test("accepting the resume prompt skips annotated jobs, and the prompt only counts jobs it would print", async () => {
	const { engine, state } = loadEngine({ jobs: fixtures(), storeData: { autoPrintArmed: true } });
	engine.start();
	engine.onJobsReconciled(state.jobs);
	await settle();
	assert.deepEqual(engine.getSnapshot().resumePrompt, { pendingJobs: AUTO_IDS.length });

	engine.resolveResumePrompt(true);
	await settle();

	assert.deepEqual(printedJobIds(state), AUTO_IDS);
	engine.stop();
});

test("resuming automated printing for an annotated job does not queue it", async () => {
	const manualJobs = fixtures().filter((j) => MANUAL_IDS.includes(j._id));
	const { engine, state } = loadEngine({ jobs: manualJobs });
	engine.start();
	engine.onJobsReconciled(state.jobs);
	engine.setAutoPrint(true);
	await settle();

	for (const id of MANUAL_IDS) {
		engine.setJobAutoPaused(id, true);
		engine.setJobAutoPaused(id, false);
	}
	await settle();

	assert.equal(state.printed.length, 0);
	assert.equal(state.statusCalls.length, 0);
	engine.stop();
});

test("the operator can still print annotated jobs by hand while automated printing is on", async () => {
	const jobs = fixtures().filter((j) => j._id === "comments" || j._id === "proof");
	const { engine, state } = loadEngine({ jobs });
	engine.start();
	engine.onJobsReconciled(state.jobs);
	engine.setAutoPrint(true);
	await settle();
	assert.equal(state.printed.length, 0);

	assert.deepEqual(await engine.printJob("comments"), { success: true });
	assert.deepEqual(await engine.printFile("proof", "proof-f1", "Printer B"), { success: true });
	await settle();

	assert.deepEqual(state.printed.map((p) => p.fileId).sort(), ["comments-f1", "comments-f2", "proof-f1"]);
	assert.equal(state.printed.find((p) => p.fileId === "proof-f1").device, "Printer B");
	engine.stop();
});

test("second gate: an already-queued automated task never dispatches once its job needs manual printing", async () => {
	const { engine, state } = loadEngine({ jobs: [job("late")] });
	state.readyFiles = new Set(); // still downloading, so the automated task waits
	engine.start();
	engine.onJobsReconciled(state.jobs);
	engine.setAutoPrint(true);
	await settle();
	assert.equal(engine.getSnapshot().files.late["late-f1"].status, "waiting");

	state.jobs[0].additionalComments = "Call before printing";
	state.readyFiles = null; // download finishes...
	state.statusListeners.forEach((fn) => fn("late-f1", "ready")); // ...which reschedules
	await settle();

	assert.equal(state.printed.length, 0);
	assert.equal(state.statusCalls.length, 0);
	assert.equal(engine.getSnapshot().files.late, undefined);
	engine.stop();
});

test("the snapshot tells the renderer which jobs are manual-only, and why", () => {
	const { engine } = loadEngine({ jobs: fixtures() });
	assert.deepEqual(engine.getSnapshot().manualOnly, {
		comments: ["additional-comments"],
		proof: ["payment-proof"],
		"proof-id": ["payment-proof"],
		"proof-unresolved": ["payment-proof"],
		both: ["additional-comments", "payment-proof"],
	});
});
