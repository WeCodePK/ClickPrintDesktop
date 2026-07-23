const { execFile } = require("child_process");

// Windows print-spooler tracking. Electron's webContents.print callback only
// confirms that a job was handed to the spooler — it says nothing about whether
// paper actually came out. Since customers are charged up front, a job that
// dies in the queue (jam, offline, out of paper, cancelled by the operator in
// the Windows UI) must be detected and reported as a real failure so the
// backend can refund. This module polls the spooler via PowerShell
// (Get-PrintJob) — same child-process pattern as printers.js — and decides a
// terminal outcome for each submitted job.
//
// Identification relies on an invariant the print engine enforces: a printer
// only ever has ONE of our files in its spool at a time. The queue is
// snapshotted before spooling; the single new job id afterwards is ours.

// Win32 JOB_STATUS_* flags (mirrored by MSFT_PrintJob.JobStatus).
const JS = {
	PAUSED: 0x1,
	ERROR: 0x2,
	DELETING: 0x4,
	SPOOLING: 0x8,
	PRINTING: 0x10,
	OFFLINE: 0x20,
	PAPEROUT: 0x40,
	PRINTED: 0x80,
	DELETED: 0x100,
	BLOCKED: 0x200,
	USER_INTERVENTION: 0x400,
	RESTART: 0x800,
	COMPLETE: 0x1000,
};

const ERROR_FLAGS = JS.ERROR | JS.OFFLINE | JS.PAPEROUT | JS.USER_INTERVENTION | JS.BLOCKED;
const GONE_FLAGS = JS.DELETING | JS.DELETED;
const DONE_FLAGS = JS.PRINTED | JS.COMPLETE;

const TICK_MS = 1200; // shared poll cadence while any verification is active
const IDENTIFY_TIMEOUT_MS = 8000; // job never appears → fast printer, assume success
const ERROR_TIMEOUT_MS = 60000; // error flags persisting this long → failure
const STUCK_TIMEOUT_MS = 300000; // no page progress for this long → failure
const MAX_POLL_FAILURES = 5; // consecutive query failures before giving up (assume success)

// PowerShell-single-quote a printer name ('' escapes ').
function psQuote(name) {
	return `'${String(name).replace(/'/g, "''")}'`;
}

function runPowershell(script, timeout = 6000) {
	return new Promise((resolve) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", script],
			{ windowsHide: true, timeout },
			(error, stdout) => {
				if (error) {
					resolve(null);
					return;
				}
				resolve(stdout || "");
			}
		);
	});
}

// Queries the spool queues of the given printers in one spawn.
// Resolves to { [device]: [{Id, S, PagesPrinted, TotalPages}] } or null on failure.
async function queryQueues(devices) {
	if (process.platform !== "win32" || devices.length === 0) return null;
	const list = devices.map(psQuote).join(",");
	const script =
		`$out=@{}; foreach ($n in @(${list})) { ` +
		`$out[$n] = @(Get-PrintJob -PrinterName $n -ErrorAction SilentlyContinue | ` +
		`Select-Object Id, @{n='S';e={[int]$_.JobStatus}}, PagesPrinted, TotalPages) }; ` +
		`$out | ConvertTo-Json -Compress -Depth 4`;
	const stdout = await runPowershell(script);
	if (stdout == null) return null;
	try {
		const parsed = JSON.parse(stdout.trim() || "{}");
		const result = {};
		for (const device of devices) {
			const rows = parsed[device];
			result[device] = Array.isArray(rows) ? rows : rows ? [rows] : [];
		}
		return result;
	} catch (err) {
		console.error("[Spooler] queue parse failed:", err.message);
		return null;
	}
}

// Best-effort purge of a stuck/errored job so the printer's queue is clean for
// the next dispatch. Fire-and-forget.
function removeSpoolJob(device, jobId) {
	const script = `Remove-PrintJob -PrinterName ${psQuote(device)} -ID ${Number(jobId)} -ErrorAction SilentlyContinue`;
	runPowershell(script).then(() => {
		console.log(`[Spooler] removed spool job ${jobId} on "${device}"`);
	});
}

// ── active verifications ─────────────────────────────────────────────────────
// device -> track. One per printer (engine enforces one in-flight file each).
const _tracks = new Map();
let _timer = null;
let _polling = false;
let _pollFailures = 0;

function _ensureTimer() {
	if (!_timer) _timer = setInterval(_poll, TICK_MS);
}

function _stopTimerIfIdle() {
	if (_tracks.size === 0 && _timer) {
		clearInterval(_timer);
		_timer = null;
		_pollFailures = 0;
	}
}

function _finish(track, outcome, detail) {
	if (track.settled) return;
	track.settled = true;
	_tracks.delete(track.device);
	console.log(`[Spooler] "${track.device}" verdict: ${outcome}${detail ? ` (${detail})` : ""}`);
	track.resolve({ outcome, detail: detail || null });
	_stopTimerIfIdle();
}

function _evaluate(track, rows, now) {
	// ── identify phase: find the job id that wasn't in the pre-spool snapshot ──
	if (track.phase === "identify") {
		const fresh = rows.find((r) => r && typeof r.Id === "number" && !track.beforeIds.has(r.Id));
		if (fresh) {
			track.phase = "tracking";
			track.jobId = fresh.Id;
			track.lastProgressAt = now;
			console.log(`[Spooler] "${track.device}" tracking spool job ${fresh.Id}`);
			if (track.onPhase) track.onPhase("verifying");
			// fall through to tracking evaluation below
		} else if (now - track.startedAt > IDENTIFY_TIMEOUT_MS) {
			// Never showed up: the printer finished it between the spool callback
			// and our first sighting. Chromium confirmed spooling, so call it done.
			_finish(track, "success", "completed before first poll");
			return;
		} else {
			return;
		}
	}

	// ── tracking phase ─────────────────────────────────────────────────────────
	const row = rows.find((r) => r && r.Id === track.jobId);

	if (!row) {
		// Job left the queue — decide by the last status we observed.
		const s = track.lastStatus || 0;
		if (s & GONE_FLAGS && !(s & DONE_FLAGS)) {
			_finish(track, "cancelled", "removed from queue");
		} else if (s & ERROR_FLAGS) {
			_finish(track, "error", `last status 0x${s.toString(16)}`);
		} else {
			_finish(track, "success");
		}
		return;
	}

	const s = row.S || 0;
	track.lastStatus = s;

	// Page progress resets the stuck timer.
	if (row.PagesPrinted !== track.lastPages) {
		track.lastPages = row.PagesPrinted;
		track.lastProgressAt = now;
	}

	if (s & ERROR_FLAGS) {
		if (!track.errorSince) track.errorSince = now;
		if (now - track.errorSince > ERROR_TIMEOUT_MS) {
			removeSpoolJob(track.device, track.jobId);
			_finish(track, "error", `status 0x${s.toString(16)} for ${Math.round((now - track.errorSince) / 1000)}s`);
		}
		return;
	}
	track.errorSince = null;

	if (now - track.lastProgressAt > STUCK_TIMEOUT_MS) {
		removeSpoolJob(track.device, track.jobId);
		_finish(track, "stuck", "no progress");
	}
}

async function _poll() {
	if (_polling || _tracks.size === 0) return;
	_polling = true;
	try {
		const devices = [...new Set([..._tracks.values()].map((t) => t.device))];
		const queues = await queryQueues(devices);
		const now = Date.now();

		if (!queues) {
			// Spooler unqueryable (PS failure / printer removed). After enough
			// consecutive failures, fall back to trusting the spool callback —
			// never fail (and refund) a print we can't actually observe.
			if (++_pollFailures >= MAX_POLL_FAILURES) {
				console.warn("[Spooler] queue queries keep failing — falling back to spool-callback-only success");
				for (const track of [..._tracks.values()]) _finish(track, "success", "untrackable");
			}
			return;
		}
		_pollFailures = 0;

		for (const track of [..._tracks.values()]) {
			const rows = queues[track.device] || [];
			console.log(
				`[Spooler] poll "${track.device}":`,
				rows.map((r) => `#${r.Id} s=0x${(r.S || 0).toString(16)} p=${r.PagesPrinted}/${r.TotalPages}`).join(" ") || "(empty)"
			);
			_evaluate(track, rows, now);
		}
	} finally {
		_polling = false;
	}
}

// ── public API ───────────────────────────────────────────────────────────────

// Snapshot of a printer's current spool job ids, taken BEFORE spooling ours.
// Returns a Set, or null when the queue can't be queried (→ untrackable print).
async function snapshotPrinter(device) {
	if (process.platform !== "win32") return null;
	const queues = await queryQueues([device]);
	if (!queues) {
		console.warn(`[Spooler] snapshot failed for "${device}" — print will be untrackable`);
		return null;
	}
	return new Set(queues[device].map((r) => r.Id).filter((id) => typeof id === "number"));
}

// Watches the printer's queue until our job (the one not in `beforeIds`)
// reaches a terminal state. Resolves { outcome: "success"|"cancelled"|"error"|
// "stuck"|"aborted", detail }. Never rejects. `beforeIds === null` (snapshot
// failed / non-Windows) resolves success immediately — trust the spool callback.
function trackPrintJob(device, beforeIds, { onPhase } = {}) {
	if (beforeIds === null || process.platform !== "win32") {
		return Promise.resolve({ outcome: "success", detail: "untracked" });
	}
	// One in-flight file per printer is enforced upstream; a stale track here
	// means something went wrong — settle it as aborted and take over.
	const existing = _tracks.get(device);
	if (existing) _finish(existing, "aborted", "superseded");

	return new Promise((resolve) => {
		_tracks.set(device, {
			device,
			phase: "identify",
			beforeIds,
			jobId: null,
			lastStatus: 0,
			lastPages: undefined,
			lastProgressAt: Date.now(),
			errorSince: null,
			startedAt: Date.now(),
			settled: false,
			onPhase,
			resolve,
		});
		_ensureTimer();
		_poll(); // immediate first look — fast printers finish quickly
	});
}

// Stops all verifications (engine shutdown / logout). Physical prints continue;
// we just stop watching. Pending trackers resolve "aborted".
function abortAll() {
	for (const track of [..._tracks.values()]) _finish(track, "aborted", "engine stopped");
}

module.exports = { snapshotPrinter, trackPrintJob, abortAll, JOB_STATUS: JS };
