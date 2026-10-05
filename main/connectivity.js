// Whether the ClickPrint backend can be reached right now. Everything that has
// to behave differently through an outage — the outbox, downloads, WhatsApp, the
// renderer's offline banner — asks here instead of guessing from its own last
// failure.
//
// Fed by the outcome of every request (http.js onOutcome) and by the jobs SSE
// stream. One success means online; FAILURES_TO_OFFLINE failures in a row mean
// offline, so a single dropped packet doesn't flash the banner. While offline a
// cheap probe runs on a backoff, so coming back is noticed even when nothing
// else is making requests. onOnline handlers run, in registration order, on
// every offline → online transition — that's where queued work gets flushed.
//
// A 401 is not "offline": the server answered. It sets `authExpired` instead.
//
// No Electron imports — createConnectivity is tested under plain `node --test`.

const FAILURES_TO_OFFLINE = 2;
const PROBE_MIN_MS = 3000;
const PROBE_MAX_MS = 30000;

// Gateway errors mean the backend itself is down — as good as offline for
// everything that needs it. Other 5xx are one route's bug, not an outage.
const UNREACHABLE_STATUSES = new Set([502, 503, 504]);

function createConnectivity({ now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
	let online = true;
	let since = now();
	let lastOnlineAt = now();
	let authExpired = false;
	let failures = 0;

	let probe = null; // async () => any; its request outcome feeds back in
	let probeTimer = null;
	let probeDelay = PROBE_MIN_MS;
	let probing = false;

	const changeListeners = [];
	const onlineListeners = [];

	function snapshot() {
		return { online, since, lastOnlineAt, authExpired };
	}

	function emit() {
		const s = snapshot();
		for (const fn of changeListeners) {
			try {
				fn(s);
			} catch (error) {
				console.error("[Net] change listener error:", error);
			}
		}
	}

	function goOnline() {
		failures = 0;
		lastOnlineAt = now();
		stopProbe();
		if (online) return;
		online = true;
		since = now();
		console.log("[Net] back online");
		emit();
		for (const fn of onlineListeners) {
			try {
				const result = fn();
				if (result?.catch) result.catch((error) => console.error("[Net] onOnline handler error:", error));
			} catch (error) {
				console.error("[Net] onOnline handler error:", error);
			}
		}
	}

	function goOffline() {
		if (!online) return;
		online = false;
		since = now();
		console.warn("[Net] offline");
		emit();
		scheduleProbe(true);
	}

	function reportSuccess() {
		goOnline();
	}

	function reportFailure() {
		failures += 1;
		if (failures >= FAILURES_TO_OFFLINE) goOffline();
		else if (!online) scheduleProbe(false);
	}

	// An http.js outcome: { kind, status }.
	function report({ kind, status } = {}) {
		if (kind === "network" || kind === "timeout" || (kind === "server" && UNREACHABLE_STATUSES.has(status))) {
			reportFailure();
			return;
		}
		if (kind === "auth" && !authExpired) {
			authExpired = true;
			console.warn("[Net] session expired (401)");
			goOnline();
			emit();
			return;
		}
		goOnline();
	}

	function clearAuthExpired() {
		if (!authExpired) return;
		authExpired = false;
		emit();
	}

	// ── probe ───────────────────────────────────────────────────────────────────

	function setProbe(fn) {
		probe = fn;
		if (!online) scheduleProbe(true);
	}

	function stopProbe() {
		if (probeTimer) clearTimer(probeTimer);
		probeTimer = null;
		probeDelay = PROBE_MIN_MS;
	}

	function scheduleProbe(reset) {
		if (!probe || online) return;
		if (reset) probeDelay = PROBE_MIN_MS;
		if (probeTimer) return;
		const delay = probeDelay;
		probeDelay = Math.min(probeDelay * 2, PROBE_MAX_MS);
		probeTimer = setTimer(runProbe, delay);
		probeTimer?.unref?.();
	}

	async function runProbe() {
		probeTimer = null;
		if (online || !probe || probing) return;
		probing = true;
		try {
			await probe();
		} catch (error) {
			console.error("[Net] probe error:", error.message);
		} finally {
			probing = false;
		}
		// Still offline: the probe's own failure was reported; go again later.
		scheduleProbe(false);
	}

	// Ask for a check now (e.g. the operator pressed Retry), instead of waiting
	// out the backoff.
	function checkNow() {
		if (online) return;
		if (probeTimer) clearTimer(probeTimer);
		probeTimer = null;
		runProbe();
	}

	// ── subscriptions ───────────────────────────────────────────────────────────

	function onChange(fn) {
		changeListeners.push(fn);
	}

	function onOnline(fn) {
		onlineListeners.push(fn);
	}

	return {
		isOnline: () => online,
		snapshot,
		report,
		reportSuccess,
		reportFailure,
		clearAuthExpired,
		setProbe,
		checkNow,
		onChange,
		onOnline,
	};
}

// The app-wide instance, fed by every backend request.
const connectivity = createConnectivity();
require("./http").onOutcome((outcome) => connectivity.report(outcome));

module.exports = { ...connectivity, createConnectivity, FAILURES_TO_OFFLINE };
