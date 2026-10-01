// Automatic updates (main/updater.js) hold the print engine until whatever is at
// a printer finishes, then relaunch into the new version and carry on. These
// drive the REAL print engine with in-memory stand-ins (see engineHarness).
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { loadEngine, settle } = require("./helpers/engineHarness");

const doc = (id) => ({ file: { _id: id, name: `${id}.pdf` }, settings: { pageType: "A4" } });
const job = (id, docIds = [`${id}-f1`]) => ({
	_id: id,
	status: "submitted",
	additionalComments: "",
	files: docIds.map(doc),
});
const printedIds = (state) => state.printed.map((p) => p.fileId);

test("an update hold lets the document at the printer finish and starts nothing else", async () => {
	const { engine, state } = loadEngine({ jobs: [job("a", ["a-f1", "a-f2"]), job("b")] });
	state.holdPrints = true;
	engine.start();
	engine.onJobsReconciled(state.jobs);
	engine.setAutoPrint(true);
	await settle();
	// Sequential per job: a-f1 and b-f1 are at the printer, a-f2 waits its turn.
	assert.deepEqual(printedIds(state).sort(), ["a-f1", "b-f1"]);

	engine.holdForUpdate();
	let idle = false;
	engine.whenNothingPrinting().then(() => (idle = true));
	assert.equal(engine.getSnapshot().updateHold, true);

	// Manual prints are refused outright.
	const refused = await engine.printFile("a", "a-f2");
	assert.equal(refused.reason, "updating");

	state.pendingPrints.shift()(); // a-f1 finishes
	await settle();
	assert.equal(idle, false, "b-f1 is still printing");
	assert.deepEqual(printedIds(state).sort(), ["a-f1", "b-f1"], "a-f2 must not start during the hold");

	state.pendingPrints.shift()(); // b-f1 finishes
	await settle();
	assert.equal(idle, true);
	const snap = engine.getSnapshot();
	assert.ok(snap.printedFiles.a["a-f1"], "an in-flight document is recorded as printed");
	assert.equal(snap.files.a["a-f2"].waitReason, "updating");
	assert.ok(state.statusCalls.some((c) => c.jobId === "b" && c.status === "completed"), "a finished job still completes");
	engine.stop();
});

test("the relaunched app resumes automated printing on its own, keeping parked jobs parked", async () => {
	// ── outgoing process ──
	const before = loadEngine({ jobs: [job("a", ["a-f1", "a-f2"]), job("parked"), job("stopped")] });
	before.state.holdPrints = true;
	// Only job a's files are downloaded, so the others sit queued while the
	// operator pauses / stops them.
	before.state.readyFiles = new Set(["a-f1", "a-f2"]);
	before.engine.start();
	before.engine.onJobsReconciled(before.state.jobs);
	before.engine.setAutoPrint(true);
	await before.engine.setJobAutoPaused("parked", true);
	before.engine.stopJobBatch("stopped"); // operator withdrew its queued docs
	await settle();
	before.engine.holdForUpdate();
	while (before.state.pendingPrints.length) before.state.pendingPrints.shift()();
	await before.engine.whenNothingPrinting();
	await settle();
	const exported = before.engine.exportUpdateState();
	before.engine.stop();

	// ── relaunched process ──
	const jobs = [job("a", ["a-f1", "a-f2"]), job("parked"), job("stopped"), job("arrived-during-restart")];
	const after = loadEngine({
		jobs,
		storeData: {
			printedFiles: before.state.store.get("printedFiles"),
			autoPrintArmed: true,
			updateHandoff: { savedAt: Date.now(), engine: exported },
		},
	});
	after.engine.start();
	after.engine.onJobsReconciled(jobs);
	await settle();

	const snap = after.engine.getSnapshot();
	assert.equal(snap.resumePrompt, null, "nobody is asked anything");
	assert.equal(snap.autoPrint, true);
	assert.equal(snap.autoPaused.parked, "operator");
	assert.deepEqual(printedIds(after.state).sort(), ["a-f2", "arrived-during-restart-f1"]);
	assert.equal(after.state.store.has("updateHandoff"), false, "the handoff is consumed");
	after.engine.stop();
});

test("a stale handoff is ignored and the usual resume question is asked", async () => {
	const { engine, state } = loadEngine({
		jobs: [job("a")],
		storeData: {
			autoPrintArmed: true,
			updateHandoff: { savedAt: Date.now() - 60 * 60 * 1000, engine: { autoPrint: true } },
		},
	});
	engine.start();
	engine.onJobsReconciled(state.jobs);
	await settle();
	const snap = engine.getSnapshot();
	assert.equal(snap.autoPrint, false);
	assert.ok(snap.resumePrompt);
	assert.equal(state.printed.length, 0);
	engine.stop();
});
