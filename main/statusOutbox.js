// Job status transitions the backend hasn't confirmed yet, kept on disk and
// replayed in order once it can be reached. Printing doesn't stop for an
// outage: the operator prints a cached job by hand, the "printing" and
// "completed" transitions land here, and they reach the backend — in order,
// across restarts — when the connection comes back. Acknowledging new jobs
// (submitted → queued) goes through here too.
//
// Only the transitions printing itself produces belong here. Cancelling and
// failing a job change what the customer pays, so they are never queued: they
// need a live connection (see printEngine declineJob / forceFailJob).
//
// Replay outcomes per entry:
//   success                → dequeued
//   offline / 5xx          → kept; the flush stops (retried on reconnect)
//   401                    → kept; the outbox pauses until resumeAuth()
//   rejected (4xx)         → the job's real status is fetched and decides:
//       already there or past it → dropped (it landed some other way)
//       behind it                → the missing steps are replayed first
//       cancelled / failed       → dropped; onConflict if we printed it
//                                   (a customer cancelled during the outage)
//
// No Electron imports — createStatusOutbox is tested under plain `node --test`.

const STORE_KEY = "jobStatusOutbox";
const HEARTBEAT_MS = 30000;
const MAX_REJECTIONS = 3;

// The backend's forward path. Every transition is a single step along it.
const FLOW = ["submitted", "queued", "printing", "completed"];
const rank = (status) => FLOW.indexOf(status);
const STOPPED = new Set(["cancelled", "failed"]);

function createStatusOutbox({
	store,
	updateJobStatus,
	// (jobId) => Promise<status | null>: the job's current backend status.
	fetchJobStatus,
	isOnline = () => true,
	setTimer = setTimeout,
	clearTimer = clearTimeout,
	now = () => Date.now(),
}) {
	let paused = false; // 401: wait for a fresh login
	let flushing = null;
	let flushAgain = false;
	let heartbeat = null;
	let onChange = null;
	let onConflict = null;
	// "jobId:status" pairs confirmed this session, so a job list fetched before
	// the confirmation can't enqueue the same transition again.
	const applied = new Set();

	// Held in memory (the engine asks about every job on every push); the store
	// is read once and written through.
	let cache = null;

	function read() {
		if (!cache) {
			const saved = store.get(STORE_KEY);
			cache = Array.isArray(saved) ? saved.filter((e) => e && e.jobId && e.status) : [];
		}
		return cache.map((e) => ({ ...e }));
	}

	function write(entries) {
		cache = entries.map((e) => ({ ...e }));
		store.set(STORE_KEY, cache);
		if (onChange) {
			try {
				onChange(summary(entries));
			} catch (error) {
				console.error("[Outbox] change listener error:", error);
			}
		}
	}

	// { total, byJob: { jobId: count } }
	function summary(entries = read()) {
		const byJob = {};
		for (const e of entries) byJob[e.jobId] = (byJob[e.jobId] || 0) + 1;
		return { total: entries.length, byJob };
	}

	function pendingFor(jobId) {
		return read().filter((e) => e.jobId === jobId);
	}

	function hasPending(jobId) {
		return read().some((e) => e.jobId === jobId);
	}

	// The status the job will have once its queued transitions land, or null.
	function latestStatus(jobId) {
		const mine = pendingFor(jobId);
		return mine.length ? mine[mine.length - 1].status : null;
	}

	function wasApplied(jobId, status) {
		return applied.has(`${jobId}:${status}`);
	}

	// Queues a transition (deduplicated against what's already queued for the
	// job) and starts a flush. Returns true when it was queued.
	function enqueue(jobId, status) {
		if (!jobId || !status) return false;
		if (wasApplied(jobId, status)) return false;
		const entries = read();
		const mine = entries.filter((e) => e.jobId === jobId);
		if (mine.some((e) => e.status === status)) return false;
		entries.push({ jobId, status, enqueuedAt: now(), rejections: 0 });
		write(entries);
		console.log(`[Outbox] queued ${jobId} → ${status}`);
		void flush();
		return true;
	}

	// Drops every queued transition of a job (e.g. it was failed by the operator).
	function dropJob(jobId) {
		const entries = read();
		const kept = entries.filter((e) => e.jobId !== jobId);
		if (kept.length !== entries.length) write(kept);
	}

	function remove(entry) {
		const entries = read().filter((e) => !(e.jobId === entry.jobId && e.status === entry.status));
		write(entries);
	}

	function replace(entry, replacements) {
		const entries = read();
		const i = entries.findIndex((e) => e.jobId === entry.jobId && e.status === entry.status);
		if (i < 0) return;
		entries.splice(i, 1, ...replacements);
		write(entries);
	}

	// Decides what a rejected transition means from the job's real status.
	// Returns "next" to carry on with the queue, or "stop".
	async function resolveRejection(entry, result) {
		const server = await fetchJobStatus(entry.jobId);
		if (server === undefined) return "stop"; // couldn't find out (offline) — try later

		if (server == null) {
			console.warn(`[Outbox] ${entry.jobId} → ${entry.status} rejected (${result.message}); job not found — dropping`);
			dropJob(entry.jobId);
			return "next";
		}
		if (STOPPED.has(server)) {
			console.warn(`[Outbox] ${entry.jobId} is ${server} on the backend — dropping its queued transitions`);
			const printed = pendingFor(entry.jobId).some((e) => rank(e.status) >= rank("printing"));
			dropJob(entry.jobId);
			if (printed && onConflict) {
				try {
					onConflict(entry.jobId, server);
				} catch (error) {
					console.error("[Outbox] conflict handler error:", error);
				}
			}
			return "next";
		}
		if (rank(server) >= rank(entry.status)) {
			console.log(`[Outbox] ${entry.jobId} is already ${server} — ${entry.status} not needed`);
			applied.add(`${entry.jobId}:${entry.status}`);
			remove(entry);
			return "next";
		}
		// Behind: replay the missing single steps first.
		entry.rejections = (entry.rejections || 0) + 1;
		if (entry.rejections > MAX_REJECTIONS || rank(server) < 0 || rank(entry.status) < 0) {
			console.error(`[Outbox] ${entry.jobId} → ${entry.status} keeps being rejected (backend: ${server}) — dropping`);
			remove(entry);
			return "next";
		}
		const steps = FLOW.slice(rank(server) + 1, rank(entry.status) + 1)
			.filter((status) => status !== entry.status)
			.filter((status) => !pendingFor(entry.jobId).some((e) => e.status === status))
			.map((status) => ({ jobId: entry.jobId, status, enqueuedAt: now(), rejections: 0 }));
		replace(entry, [...steps, entry]);
		return "next";
	}

	// Moves every entry of a job to the back of the queue (keeping their order),
	// so one job the backend keeps erroring on doesn't hold up the others.
	function rotate(jobId) {
		const entries = read();
		write([...entries.filter((e) => e.jobId !== jobId), ...entries.filter((e) => e.jobId === jobId)]);
	}

	async function drain() {
		const rotated = new Set(); // jobs sent to the back during this pass
		while (!paused) {
			const entry = read()[0];
			if (!entry || rotated.has(entry.jobId)) return;
			const result = await updateJobStatus(entry.jobId, entry.status);
			if (result?.success) {
				applied.add(`${entry.jobId}:${entry.status}`);
				remove(entry);
				console.log(`[Outbox] synced ${entry.jobId} → ${entry.status}`);
				continue;
			}
			if (result?.kind === "auth") {
				console.warn("[Outbox] session expired — paused until the next login");
				paused = true;
				return;
			}
			if (result?.offline || !result?.kind) return; // unreachable — try again later
			if (result?.retryable) {
				// The backend answered with an error (5xx). Retried later — but after
				// a few in a row, this job steps aside for the rest of the queue.
				entry.serverErrors = (entry.serverErrors || 0) + 1;
				replace(entry, [entry]);
				if (entry.serverErrors < 3) return;
				console.warn(`[Outbox] ${entry.jobId} → ${entry.status} keeps failing (HTTP ${result.status}) — moving on`);
				entry.serverErrors = 0;
				replace(entry, [entry]);
				rotate(entry.jobId);
				rotated.add(entry.jobId);
				continue;
			}
			if ((await resolveRejection(entry, result)) === "stop") return;
		}
	}

	// Replays the queue. Coalesced: concurrent calls share one pass, plus one
	// more if something was queued meanwhile.
	function flush() {
		if (flushing) {
			flushAgain = true;
			return flushing;
		}
		flushing = (async () => {
			do {
				flushAgain = false;
				try {
					await drain();
				} catch (error) {
					console.error("[Outbox] flush failed:", error);
					return;
				}
			} while (flushAgain && !paused);
		})().finally(() => {
			flushing = null;
			armHeartbeat();
		});
		return flushing;
	}

	// While anything is queued, retry every HEARTBEAT_MS when online — the
	// reconnect itself (onOnline → flush) is the main trigger.
	function armHeartbeat() {
		if (heartbeat) clearTimer(heartbeat);
		heartbeat = null;
		if (!read().length || paused) return;
		heartbeat = setTimer(() => {
			heartbeat = null;
			if (isOnline()) void flush();
			else armHeartbeat();
		}, HEARTBEAT_MS);
		heartbeat?.unref?.();
	}

	function resumeAuth() {
		if (!paused) return;
		paused = false;
		void flush();
	}

	function stop() {
		if (heartbeat) clearTimer(heartbeat);
		heartbeat = null;
	}

	return {
		enqueue,
		flush,
		dropJob,
		hasPending,
		pendingFor,
		latestStatus,
		wasApplied,
		summary: () => summary(),
		resumeAuth,
		stop,
		isPaused: () => paused,
		setChangeListener: (fn) => (onChange = fn),
		setConflictHandler: (fn) => (onConflict = fn),
	};
}

module.exports = { createStatusOutbox, STORE_KEY, FLOW };
