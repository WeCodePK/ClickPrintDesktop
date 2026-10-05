// The online/offline tracker (main/connectivity.js): one success means online,
// two failures in a row mean offline, a 401 is "session expired" rather than an
// outage, and while offline a probe runs on a doubling backoff. Timers are
// driven by hand.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createConnectivity } = require("../main/connectivity");

function setup() {
	const timers = [];
	const net = createConnectivity({
		setTimer: (fn, ms) => {
			const t = { fn, ms };
			timers.push(t);
			return t;
		},
		clearTimer: (t) => {
			const i = timers.indexOf(t);
			if (i >= 0) timers.splice(i, 1);
		},
	});
	const changes = [];
	net.onChange((s) => changes.push(s.online));
	return { net, timers, changes };
}

test("one dropped request doesn't flip it offline; two in a row do", () => {
	const { net, changes } = setup();
	net.report({ kind: "timeout" });
	assert.equal(net.isOnline(), true);
	net.report({ kind: "network" });
	assert.equal(net.isOnline(), false);
	assert.deepEqual(changes, [false]);
});

test("a success in between resets the count", () => {
	const { net } = setup();
	net.report({ kind: "network" });
	net.report({ kind: "ok" });
	net.report({ kind: "network" });
	assert.equal(net.isOnline(), true);
});

test("coming back runs every onOnline handler once, in registration order", () => {
	const { net } = setup();
	const calls = [];
	net.onOnline(() => calls.push("reconcile"));
	net.onOnline(() => calls.push("outbox"));
	net.reportFailure();
	net.reportFailure();
	net.report({ kind: "ok" });
	net.report({ kind: "ok" });
	assert.deepEqual(calls, ["reconcile", "outbox"]);
});

test("only gateway errors count as the backend being down", () => {
	const { net } = setup();
	net.report({ kind: "server", status: 500 });
	net.report({ kind: "server", status: 500 });
	assert.equal(net.isOnline(), true, "a route's own 500 is not an outage");
	net.report({ kind: "server", status: 502 });
	net.report({ kind: "server", status: 504 });
	assert.equal(net.isOnline(), false);
});

test("a 401 marks the session expired without going offline", () => {
	const { net } = setup();
	net.report({ kind: "auth", status: 401 });
	assert.deepEqual([net.isOnline(), net.snapshot().authExpired], [true, true]);
	net.clearAuthExpired();
	assert.equal(net.snapshot().authExpired, false);
});

test("while offline a probe runs on a doubling backoff, and stops once back", async () => {
	const { net, timers } = setup();
	let probes = 0;
	net.setProbe(async () => {
		probes++;
	});
	net.reportFailure();
	net.reportFailure();
	assert.deepEqual(timers.map((t) => t.ms), [3000]);

	await timers.shift().fn();
	assert.equal(probes, 1);
	assert.deepEqual(timers.map((t) => t.ms), [6000]);

	net.report({ kind: "ok" });
	assert.deepEqual(timers, [], "no probing while online");
});
