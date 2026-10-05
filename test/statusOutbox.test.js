// The job status outbox (main/statusOutbox.js): transitions made while the
// backend is unreachable are kept (across restarts) and replayed in order, and
// a rejected replay is settled from the job's real status — already applied,
// missing steps, or a customer cancellation that happened during the outage.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createStatusOutbox } = require("../main/statusOutbox");

function setup({ serverStatus = {}, data = new Map() } = {}) {
	const backend = { online: true, status: { ...serverStatus }, calls: [] };
	const store = {
		get: (key) => (data.has(key) ? JSON.parse(data.get(key)) : undefined),
		set: (key, value) => (data.set(key, JSON.stringify(value)), true),
	};
	// A tiny backend that enforces single-step transitions.
	const FLOW = ["submitted", "queued", "printing", "completed"];
	const updateJobStatus = async (jobId, status) => {
		backend.calls.push(`${jobId}:${status}`);
		if (!backend.online) return { success: false, kind: "network", offline: true, retryable: true };
		if (backend.authExpired) return { success: false, kind: "auth", status: 401 };
		if (backend.erroring === jobId) return { success: false, kind: "server", status: 500, retryable: true };
		const current = backend.status[jobId];
		if (FLOW.indexOf(status) !== FLOW.indexOf(current) + 1) return { success: false, kind: "http", status: 409, message: "invalid transition" };
		backend.status[jobId] = status;
		return { success: true };
	};
	const outbox = createStatusOutbox({
		store,
		updateJobStatus,
		fetchJobStatus: async (jobId) => (backend.online ? backend.status[jobId] ?? null : undefined),
		setTimer: () => null,
		clearTimer: () => {},
	});
	return { outbox, backend, data, store };
}

const pending = (outbox, jobId) => outbox.pendingFor(jobId).map((e) => e.status);

test("transitions queued offline replay in order once the backend is back", async () => {
	const { outbox, backend } = setup({ serverStatus: { j1: "queued" } });
	backend.online = false;
	outbox.enqueue("j1", "printing");
	outbox.enqueue("j1", "completed");
	await outbox.flush();
	assert.deepEqual(pending(outbox, "j1"), ["printing", "completed"], "kept while offline");

	backend.online = true;
	await outbox.flush();
	assert.deepEqual(pending(outbox, "j1"), []);
	assert.equal(backend.status.j1, "completed");
	assert.equal(outbox.latestStatus("j1"), null);
});

test("the queue survives a restart", async () => {
	const first = setup({ serverStatus: { j1: "queued" } });
	first.backend.online = false;
	first.outbox.enqueue("j1", "printing");
	await first.outbox.flush();

	const second = setup({ serverStatus: { j1: "queued" }, data: first.data });
	assert.deepEqual(pending(second.outbox, "j1"), ["printing"]);
	assert.equal(second.outbox.latestStatus("j1"), "printing");
	await second.outbox.flush();
	assert.equal(second.backend.status.j1, "printing");
});

test("the same transition is never queued twice", () => {
	const { outbox, backend } = setup();
	backend.online = false;
	assert.equal(outbox.enqueue("j1", "queued"), true);
	assert.equal(outbox.enqueue("j1", "queued"), false);
	assert.equal(outbox.summary().total, 1);
});

test("a transition that already landed some other way is dropped quietly", async () => {
	const { outbox, backend } = setup({ serverStatus: { j1: "printing" } });
	outbox.enqueue("j1", "queued"); // the ack; meanwhile the job went further
	await outbox.flush();
	assert.deepEqual(pending(outbox, "j1"), []);
	assert.equal(backend.status.j1, "printing");
	assert.equal(outbox.wasApplied("j1", "queued"), true);
});

test("a job behind the queued transition gets the missing steps first", async () => {
	const { outbox, backend } = setup({ serverStatus: { j1: "submitted" } });
	outbox.enqueue("j1", "completed");
	await outbox.flush();
	assert.equal(backend.status.j1, "completed");
	assert.deepEqual(backend.calls, ["j1:completed", "j1:queued", "j1:printing", "j1:completed"]);
});

test("a job cancelled during the outage after it printed raises a conflict", async () => {
	const { outbox, backend } = setup({ serverStatus: { j1: "queued" } });
	const conflicts = [];
	outbox.setConflictHandler((jobId, status) => conflicts.push([jobId, status]));
	backend.online = false;
	outbox.enqueue("j1", "printing");
	outbox.enqueue("j1", "completed");
	await outbox.flush();

	backend.status.j1 = "cancelled"; // the customer cancelled online meanwhile
	backend.online = true;
	await outbox.flush();
	assert.deepEqual(conflicts, [["j1", "cancelled"]]);
	assert.deepEqual(pending(outbox, "j1"), []);
});

test("a cancelled ack is no conflict — nothing was printed", async () => {
	const { outbox, backend } = setup({ serverStatus: { j1: "cancelled" } });
	const conflicts = [];
	outbox.setConflictHandler((jobId) => conflicts.push(jobId));
	outbox.enqueue("j1", "queued");
	await outbox.flush();
	assert.deepEqual(conflicts, []);
	assert.deepEqual(pending(outbox, "j1"), []);
});

test("an expired session pauses the outbox without losing anything", async () => {
	const { outbox, backend } = setup({ serverStatus: { j1: "queued" } });
	backend.authExpired = true;
	outbox.enqueue("j1", "printing");
	await outbox.flush();
	assert.equal(outbox.isPaused(), true);
	assert.deepEqual(pending(outbox, "j1"), ["printing"]);

	backend.authExpired = false;
	outbox.resumeAuth();
	await outbox.flush();
	assert.deepEqual(pending(outbox, "j1"), []);
});

test("a job the backend keeps erroring on steps aside for the others", async () => {
	const { outbox, backend } = setup({ serverStatus: { bad: "queued", good: "queued" } });
	backend.erroring = "bad"; // every PATCH for it is a 500 from a backend bug
	outbox.enqueue("bad", "printing"); // 1st error (enqueue flushes)
	outbox.enqueue("good", "printing");
	await outbox.flush(); // 2nd
	assert.equal(backend.status.good, "queued", "still waiting behind it");
	await outbox.flush(); // 3rd → it steps aside and "good" goes through
	assert.equal(backend.status.good, "printing");
	assert.deepEqual(pending(outbox, "bad"), ["printing"], "kept for later");
});

test("one job's stuck transition doesn't reorder another job's", async () => {
	const { outbox, backend } = setup({ serverStatus: { a: "queued", b: "queued" } });
	backend.online = false;
	outbox.enqueue("a", "printing");
	outbox.enqueue("b", "printing");
	outbox.enqueue("a", "completed");
	await outbox.flush();
	backend.online = true;
	await outbox.flush();
	assert.deepEqual(backend.calls.filter((c) => c.startsWith("a:")).slice(-2), ["a:printing", "a:completed"]);
	assert.equal(backend.status.b, "printing");
});
