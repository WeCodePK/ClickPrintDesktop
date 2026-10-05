// Printing through an outage. Manual printing carries on from cached files with
// the job's status transitions queued in the outbox (statusOutbox.js) and
// replayed in order once the backend is back; automated printing waits for the
// connection; cancelling and failing (which move money) are refused offline.
// Drives the REAL engine and the REAL outbox over the harness's stub backend.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { loadEngine, settle } = require("./helpers/engineHarness");

const job = (id, status = "queued", docIds = [`${id}-f1`]) => ({
	_id: id,
	status,
	additionalComments: "",
	files: docIds.map((fileId) => ({ file: { _id: fileId, name: `${fileId}.pdf` }, settings: { pageType: "A4" } })),
});

const queued = (state, jobId) => state.outbox.pendingFor(jobId).map((e) => e.status);
const sentOnline = (state, jobId) => state.statusCalls.filter((c) => c.jobId === jobId && c.online).map((c) => c.status);
const statusOf = (engine, state, jobId) => engine.applyOverrides(state.jobs).find((j) => j._id === jobId).status;

test("an offline manual print goes ahead, and its transitions sync in order once back online", async () => {
	const { engine, state } = loadEngine({ jobs: [job("j1")] });
	engine.start();
	engine.onJobsReconciled(state.jobs);
	state.setOnline(false);

	assert.deepEqual(await engine.printJob("j1"), { success: true });
	await settle();

	assert.deepEqual(state.printed.map((p) => p.fileId), ["j1-f1"], "the document printed");
	assert.deepEqual(queued(state, "j1"), ["printing", "completed"]);
	assert.equal(statusOf(engine, state, "j1"), "completed", "shown as completed while the sync is pending");
	assert.equal(engine.getSnapshot().pendingSync.byJob.j1, 2);

	state.setOnline(true);
	await state.outbox.flush();
	assert.deepEqual(sentOnline(state, "j1"), ["printing", "completed"]);
	assert.deepEqual(queued(state, "j1"), []);
	engine.stop();
});

test("a job printed offline before it was acknowledged replays the ack first", async () => {
	const { engine, state } = loadEngine({ jobs: [job("j2", "submitted")] });
	engine.start();
	engine.onJobsReconciled(state.jobs);
	state.setOnline(false);

	await engine.printJob("j2");
	await settle();
	assert.deepEqual(queued(state, "j2"), ["queued", "printing", "completed"]);

	state.setOnline(true);
	await state.outbox.flush();
	assert.deepEqual(sentOnline(state, "j2"), ["queued", "printing", "completed"]);
	engine.stop();
});

test("a stale job list doesn't resurrect a job printed offline", async () => {
	const { engine, state } = loadEngine({ jobs: [job("j3")] });
	engine.start();
	engine.onJobsReconciled(state.jobs);
	state.setOnline(false);
	await engine.printJob("j3");
	await settle();

	// The backend's (cached) copy still says "queued".
	engine.onJobsReconciled([job("j3")]);
	await settle();
	assert.equal(statusOf(engine, state, "j3"), "completed");
	assert.equal(state.printed.length, 1, "never printed twice");
	assert.equal(engine.getSnapshot().files.j3, undefined, "no task re-queued");
	engine.stop();
});

test("automated printing waits for the connection, then picks up", async () => {
	const { engine, state } = loadEngine({ jobs: [] });
	engine.start();
	engine.onJobsReconciled([]);
	engine.setAutoPrint(true);
	state.setOnline(false);

	state.jobs = [job("a1")];
	engine.onJobsReconciled(state.jobs);
	await settle();
	assert.equal(state.printed.length, 0, "nothing prints automatically while offline");
	assert.equal(engine.getSnapshot().files.a1["a1-f1"].waitReason, "offline");
	assert.deepEqual(queued(state, "a1"), [], "no transition queued for unconfirmed automated work");

	state.setOnline(true);
	await settle();
	assert.deepEqual(state.printed.map((p) => p.fileId), ["a1-f1"]);
	assert.deepEqual(sentOnline(state, "a1"), ["printing", "completed"]);
	engine.stop();
});

test("cancelling and failing a job are refused while offline, without touching the backend", async () => {
	const { engine, state } = loadEngine({ jobs: [job("c1")] });
	engine.start();
	engine.onJobsReconciled(state.jobs);
	state.setOnline(false);

	assert.equal((await engine.declineJob("c1")).reason, "offline");
	assert.equal((await engine.forceFailJob("c1")).reason, "offline");
	assert.deepEqual(state.statusCalls, []);
	assert.equal(statusOf(engine, state, "c1"), "queued");
	engine.stop();
});

test("a connection that drops mid-transition queues the print instead of failing it", async () => {
	const { engine, state } = loadEngine({ jobs: [job("d1")] });
	engine.start();
	engine.onJobsReconciled(state.jobs);
	// Connectivity still believes it's online, but the requests themselves fail.
	state.failRequests = true;

	assert.deepEqual(await engine.printJob("d1"), { success: true });
	await settle();
	assert.deepEqual(state.printed.map((p) => p.fileId), ["d1-f1"]);
	assert.ok(state.statusCalls.some((c) => c.jobId === "d1" && c.status === "printing"), "the PATCH was attempted");
	assert.deepEqual(queued(state, "d1"), ["printing", "completed"]);
	engine.stop();
});
