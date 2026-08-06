const {
	fetchServices,
	fetchPrinters,
	updateJobStatus,
	markJobFailed,
} = require("./api");
const { listPrinters } = require("./printers");
const files = require("./files");
const spooler = require("./spooler");
const registry = require("./printerRegistry");
const store = require("./store");
const { getJobs } = require("./state");

// ─────────────────────────────────────────────────────────────────────────────
// The print engine: owns ALL print orchestration and state in the main process.
// The renderer is a pure view — it mirrors the engine snapshot and sends
// commands over IPC.
//
// Model:
//  - Every printable document is a task {jobId, fileId}. Tasks live in a FIFO
//    list; each is matched to a service by its print settings and dispatched to
//    the least-loaded printer of that service (printerRegistry.choosePrinter).
//  - A printer holds a QUEUE of our documents (printerRegistry), so work is
//    spread across a service's printers instead of waiting for one to go idle.
//    Only the spool step is serialised per printer — see withSpoolLock — because
//    the spooler identifies our job by diffing the queue around a single spool.
//  - Print-all (Part 2) and automated printing (Part 3) are both SEQUENTIAL per
//    job: those tasks carry `sequential` and the scheduler holds each one back
//    until the job has nothing at a printer. The task list is the job's own
//    queue — documents reach the Windows spooler one at a time, each picking its
//    printer (override, or choosePrinter's least-loaded match) at ITS dispatch
//    moment, not all up front.
//  - "Printed" means verified against the Windows spooler (files.printAndVerify),
//    not merely spooled.
//  - Failure policy — a failure is ALWAYS permanent (never retried behind the
//    operator's back) and NEVER fails the job:
//      manual — the document is flagged; a print-all batch stops there. The
//        operator retries it or fails the job explicitly.
//      auto   — automated printing is paused for that job (autoPausedJobs), which
//        surfaces it as needing attention and restores its manual controls.
//    The refund PATCH has exactly one trigger in the whole engine: forceFailJob,
//    the operator's "mark entire job as failed" control.
// ─────────────────────────────────────────────────────────────────────────────

const ACTIVE_STATUSES = new Set(["draft", "submitted", "queued", "processing", "printing"]);
const ROUTING_POLL_MS = 20000;
const PRINTED_STORE_KEY = "printedFiles";
// Remembers ACROSS sessions that automated printing was armed when the app last
// closed. It never re-arms anything by itself — it only decides whether the next
// launch offers to resume (see resumePrompt). Distinct from the old "autoPrint"
// key, which silently restored the on/off state.
const AUTO_PRINT_ARMED_KEY = "autoPrintArmed";

const isPdfDevice = registry.isPdfDevice;

// Normalises a raw backend job's files: [{fileId, name, settings}].
function jobFileList(job) {
	const out = [];
	(job?.files || []).forEach((entry, i) => {
		const fileId = entry.file?._id || entry.fileId;
		if (!fileId) return;
		out.push({
			fileId,
			name: entry.file?.originalName || entry.name || `Document ${i + 1}`,
			settings: entry.settings || {},
		});
	});
	return out;
}

// Human label for toast copy.
function jobWho(job) {
	return job?.createdBy?.name || job?.createdBy?.number || `#${String(job?._id || "").slice(-6)}`;
}

// A promise plus its resolver — used to hold a printer's spool lock until the
// spooler has identified the job we just submitted.
function deferred() {
	let resolve;
	const promise = new Promise((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

// ── engine state ─────────────────────────────────────────────────────────────
const engine = {
	running: false,
	autoPrint: false,
	paused: false,
	// null | { pendingJobs: n } — set on the first reconcile of a session when
	// automated printing was armed last time. Purely a question for the operator;
	// nothing prints until they answer yes.
	resumePrompt: null,

	// Routing table (the resolved service → printer structure and each printer's
	// queue live in printerRegistry; these are the raw inputs it's built from).
	services: [],
	registeredPrinters: [],
	localPrinters: [], // online local printers [{name, displayName}]
	routingLoaded: false,

	// FIFO task list; one task per (jobId, fileId). See dispatch/schedule.
	tasks: [],

	// Persisted per-file progress: { [jobId]: { [fileId]: true } }.
	printedFiles: {},

	// Backend-transition guards / local status overrides.
	jobsMarkedPrinting: new Set(),
	jobsCompleting: new Set(),
	jobsFailing: new Set(),
	printingPatches: new Map(), // jobId -> in-flight ensureJobPrinting promise
	overrides: new Map(), // jobId -> locally-applied status, until SSE confirms

	// jobId -> "operator" | "failure". Automated printing is held for these jobs
	// only; the rest of the queue keeps flowing. "failure" means a document of
	// that job failed and it now needs manual intervention — the engine never
	// retries and never fails the job on its own, so it parks the job here and
	// surfaces it to the operator.
	autoPausedJobs: new Map(),

	seenJobs: new Set(), // jobIds already considered for auto-enqueue
	initialized: false, // first reconcile handled (resume prompt decided)
};

let _getMainWindow = null;
let _onSnapshot = null; // (snapshot) => void
let _onToast = null; // ({kind, jobId, who, fileName}) => void
let _onJobsChanged = null; // () => void  (ipc re-pushes jobs:updated with overrides)
let _routingTimer = null;
let _emitTimer = null;

// ── snapshot / events ────────────────────────────────────────────────────────

function getSnapshot() {
	const fileMap = {};
	const queuedJobIds = [];
	for (const task of engine.tasks) {
		if (!fileMap[task.jobId]) fileMap[task.jobId] = {};
		fileMap[task.jobId][task.fileId] = {
			status: task.status,
			waitReason: task.status === "waiting" ? task.waitReason : null,
			failureReason: task.failureReason,
			device: task.device,
			mode: task.mode, // "auto" | "manual" — lets the UI tell an auto hold
			// from an operator batch (only the latter offers Stop).
		};
		if (
			(task.status === "waiting" || task.status === "printing" || task.status === "verifying") &&
			!queuedJobIds.includes(task.jobId)
		) {
			queuedJobIds.push(task.jobId);
		}
	}
	return {
		running: engine.running,
		autoPrint: engine.autoPrint,
		paused: engine.paused,
		routingLoaded: engine.routingLoaded,
		autoRouteReady: registry.hasAutoRoute(),
		resumePrompt: engine.resumePrompt,
		// { [jobId]: "operator" | "failure" } — automated printing held per job.
		autoPaused: Object.fromEntries(engine.autoPausedJobs),
		queuedJobIds,
		printedFiles: engine.printedFiles,
		files: fileMap,
	};
}

// Debounced snapshot push — state changes in bursts (schedule passes, poll
// results), so coalesce into one IPC message.
function emit() {
	if (!_onSnapshot || _emitTimer) return;
	_emitTimer = setTimeout(() => {
		_emitTimer = null;
		if (_onSnapshot) _onSnapshot(getSnapshot());
	}, 50);
}

function toast(payload) {
	if (_onToast) _onToast(payload);
}

function jobsChanged() {
	if (_onJobsChanged) _onJobsChanged();
}

// Applies the engine's locally-known status transitions on top of a raw job
// list before it reaches the renderer — the UI updates instantly without the
// renderer doing its own optimistic bookkeeping.
function applyOverrides(jobs) {
	if (engine.overrides.size === 0) return jobs;
	return jobs.map((job) => {
		const status = engine.overrides.get(job._id);
		return status && job.status !== status ? { ...job, status } : job;
	});
}

// ── persisted progress ───────────────────────────────────────────────────────

function loadPrintedFiles() {
	const saved = store.get(PRINTED_STORE_KEY);
	engine.printedFiles = saved && typeof saved === "object" ? saved : {};
}

function persistPrintedFiles() {
	store.set(PRINTED_STORE_KEY, engine.printedFiles);
}

function isFilePrinted(jobId, fileId) {
	return !!engine.printedFiles[jobId]?.[fileId];
}

function markFilePrinted(jobId, fileId) {
	if (!engine.printedFiles[jobId]) engine.printedFiles[jobId] = {};
	engine.printedFiles[jobId][fileId] = true;
	persistPrintedFiles();
}

function pruneJobProgress(jobId) {
	if (engine.printedFiles[jobId]) {
		delete engine.printedFiles[jobId];
		persistPrintedFiles();
	}
}

// One-time import of the legacy renderer-localStorage progress (pre-engine
// builds). Only jobs still active are kept.
function migrateProgress(imported) {
	if (!imported || typeof imported !== "object") return;
	const activeIds = new Set(getJobs().filter((j) => ACTIVE_STATUSES.has(j.status)).map((j) => j._id));
	let changed = false;
	for (const [jobId, filesMap] of Object.entries(imported)) {
		if (!activeIds.has(jobId) || !filesMap || typeof filesMap !== "object") continue;
		engine.printedFiles[jobId] = { ...filesMap, ...(engine.printedFiles[jobId] || {}) };
		changed = true;
	}
	if (changed) {
		console.log("[Engine] migrated legacy print progress");
		persistPrintedFiles();
		emit();
	}
}

// ── routing ──────────────────────────────────────────────────────────────────

async function refreshRouting(force = false) {
	try {
		const win = _getMainWindow ? _getMainWindow() : null;
		const [local, regs, svcs] = await Promise.all([
			listPrinters(win, force).catch(() => null),
			fetchPrinters(),
			fetchServices(),
		]);
		if (Array.isArray(local)) engine.localPrinters = local;
		if (regs?.success) engine.registeredPrinters = regs.data || [];
		if (svcs?.success) engine.services = svcs.data || [];

		// Rebuild the service → printer structure. Queues are keyed by device and
		// survive this, so in-flight documents aren't disturbed by a service edit
		// or a printer blipping offline.
		registry.rebuild({
			services: engine.services,
			registeredPrinters: engine.registeredPrinters,
			localPrinters: engine.localPrinters,
		});
	} catch (err) {
		console.error("[Engine] routing refresh failed:", err);
	} finally {
		engine.routingLoaded = true;
		schedule();
		emit();
	}
}

// Sweeps each printer's queue against the real Windows spooler, dropping our
// documents that have left it (printed / failed / cancelled in the Windows UI)
// and refreshing foreign-job counts. Driven by the SSE ping and by startup.
async function reconcilePrinterQueues() {
	await registry.reconcile();
	if (engine.running) schedule();
	emit();
}

// ── task helpers ─────────────────────────────────────────────────────────────

function findTask(jobId, fileId) {
	return engine.tasks.find((t) => t.jobId === jobId && t.fileId === fileId);
}

// Adds (or refreshes) tasks for a job's unprinted files. Explicit commands
// reset failed tasks and apply overrides; auto-enqueue leaves existing tasks
// alone. In-flight tasks are never touched.
function addTasks(job, mode, overrideDevice = null, { onlyFileId = null, explicit = false, sequential = false } = {}) {
	let added = false;
	for (const file of jobFileList(job)) {
		if (onlyFileId && file.fileId !== onlyFileId) continue;
		if (isFilePrinted(job._id, file.fileId)) continue;

		const existing = findTask(job._id, file.fileId);
		if (existing) {
			if (!explicit) continue;
			if (existing.status === "printing" || existing.status === "verifying") continue;
			// Re-issue (the operator pressed Retry): clear the failure state and
			// apply the new mode/override. `attempts` is deliberately KEPT — with no
			// automatic retry it can no longer block anything, and it steers the
			// load balancer away from the printer that just failed when the operator
			// retries without picking one. An explicit dropdown choice overrides it.
			existing.status = "waiting";
			existing.waitReason = null;
			existing.failureReason = null;
			existing.mode = mode;
			existing.overrideDevice = overrideDevice;
			existing.sequential = sequential;
			existing.device = null;
			existing.notBefore = null;
			added = true;
			continue;
		}

		engine.tasks.push({
			id: `${job._id}:${file.fileId}`,
			jobId: job._id,
			fileId: file.fileId,
			fileName: file.name,
			settings: file.settings,
			mode,
			overrideDevice,
			sequential, // print-all batch: one document at a printer at a time
			status: "waiting",
			waitReason: null,
			failureReason: null,
			attempts: [],
			device: null,
			notBefore: null,
		});
		added = true;
	}
	return added;
}

// Drops a job's tasks. In-flight tasks are removed from the list too — dispatch
// notices (the task is no longer listed) and discards the outcome — and their
// printer-queue entries go with them so load balancing stops counting them.
function dropJobTasks(jobId) {
	engine.tasks = engine.tasks.filter((t) => t.jobId !== jobId);
	engine.autoPausedJobs.delete(jobId); // nothing left to hold back
	registry.dropJob(jobId);
}

// ── scheduler ────────────────────────────────────────────────────────────────

// Serialises the spool+identify step per printer. The spooler pins our job down
// by diffing that printer's queue around a single spool, so two documents must
// never be mid-spool on the same device at once. Once ours is identified the
// lock releases and the next document spools in behind it — the printer's queue
// genuinely stacks, it just fills one document at a time.
const _spoolLocks = new Map();

function withSpoolLock(device, fn) {
	const prev = _spoolLocks.get(device) || Promise.resolve();
	const next = prev.then(fn, fn); // run regardless of how the previous one ended
	_spoolLocks.set(
		device,
		next.then(
			() => {},
			() => {}
		)
	);
	return next;
}

// One synchronous pass: route each waiting task to the least-loaded printer of
// its service, in FIFO order. The registry slot is claimed synchronously before
// any await, so later tasks in the same pass already see the added load and
// re-entrancy is safe. Triggers: task added, print finished, routing refreshed,
// file ready, queue reconcile, unpause.
function schedule() {
	if (!engine.running) return;

	// Jobs that currently have a document at a printer. A print-all batch sends
	// its documents ONE AT A TIME: the next dispatches only once the previous one
	// settles (printed or failed), so a job never stacks the Windows queue. Any
	// in-flight document of the job counts — including a lone per-document print
	// — never two of the same job at once while a batch is pending.
	const busyJobs = new Set();
	for (const t of engine.tasks) {
		if (t.status === "printing" || t.status === "verifying") busyJobs.add(t.jobId);
	}

	for (const task of engine.tasks) {
		if (task.status !== "waiting") continue;
		// Automated printing held for THIS job (operator switch, or a failure that
		// needs manual intervention). Manual prints are unaffected — that is how
		// the operator intervenes.
		if (task.mode === "auto" && engine.autoPausedJobs.has(task.jobId)) {
			task.waitReason = "job-paused";
			continue;
		}
		// Global pause holds the automated queue only — an explicit operator print
		// must still go through.
		if (engine.paused && task.mode === "auto") {
			task.waitReason = "paused";
			continue;
		}

		// One-at-a-time gate for print-all batches. busyJobs also gains the job the
		// moment a document dispatches below, so a single pass never sends two.
		if (task.sequential && busyJobs.has(task.jobId)) {
			task.waitReason = "job-sequence";
			continue;
		}

		if (task.notBefore && task.notBefore > Date.now()) {
			// Backend backoff applies to the whole job — hold the batch in order.
			if (task.sequential) busyJobs.add(task.jobId);
			continue;
		}

		if (!files.isReady(task.fileId)) {
			task.waitReason = "downloading";
			// Transient: hold the batch behind this document so output order is kept.
			if (task.sequential) busyJobs.add(task.jobId);
			continue;
		}

		// Load-balanced pick; a retry prefers a printer this document hasn't tried.
		const { device, reason } = registry.choosePrinter(task.settings, {
			mode: task.mode,
			overrideDevice: task.overrideDevice,
			exclude: task.attempts.map((a) => a.device),
		});
		if (!device) {
			// Routing/hardware gap: needs operator action (or a printer coming back
			// online), so it deliberately does NOT dam the rest of the batch — later
			// documents that CAN route still print, one at a time.
			task.waitReason = reason;
			continue;
		}

		console.log(
			`[Engine] dispatch ${task.id} → "${device}" (mode=${task.mode}` +
				`${task.sequential ? ", seq" : ""}${task.overrideDevice ? ", override" : `, load=${registry.loadOf(device)}`})`
		);
		claimAndDispatch(task, device);
		if (task.sequential) busyJobs.add(task.jobId);
	}
	emit();
}

function claimAndDispatch(task, device) {
	task.status = "printing";
	task.waitReason = null;
	task.device = device;
	// Occupy the printer's queue synchronously so the remainder of this pass
	// balances around it.
	registry.enqueue(device, {
		taskId: task.id,
		jobId: task.jobId,
		fileId: task.fileId,
		fileName: task.fileName,
	});

	dispatch(task, device).catch((err) => {
		// dispatch handles its own failures; this only guards programmer error.
		console.error(`[Engine] dispatch crashed for ${task.id}:`, err);
		registry.dequeue(device, task.id);
		emit();
	});
}

async function dispatch(task, device) {
	try {
		// Job → "printing" on the backend before its first document prints. A manual
		// print already did this on click, so this is a no-op there.
		const ok = await ensureJobPrinting(task.jobId);
		if (!ok) {
			// Backend refused/unreachable — back off so schedule() doesn't spin a
			// tight PATCH loop; the routing poll re-runs it every 20s.
			if (engine.tasks.includes(task)) {
				task.status = "waiting";
				task.device = null;
				task.notBefore = Date.now() + 15000;
			}
			registry.dequeue(device, task.id);
			return;
		}

		// SSE race guard: the job may have been cancelled while we PATCHed.
		if (!engine.running || !engine.tasks.includes(task)) {
			registry.dequeue(device, task.id);
			return;
		}

		if (isPdfDevice(device)) {
			// Manual override to Print-to-PDF: Save dialog + copy. Never auto-fails.
			await files.savePdfCopy(task.fileId, task.fileName);
		} else {
			let printing = null;
			await withSpoolLock(device, async () => {
				// Re-check INSIDE the lock. While queued behind other documents on
				// this printer the engine may have stopped, or the job may have been
				// cancelled/completed remotely — spooling now would put paper out for
				// work nobody is waiting for any more.
				if (!engine.running || !engine.tasks.includes(task)) return;

				const gate = deferred();
				printing = files.printAndVerify(task.fileId, task.settings, device, task.fileName, {
					onPhase: () => {
						task.status = "verifying";
						emit();
					},
					onIdentified: (spoolId) => {
						registry.setSpoolId(device, task.id, spoolId);
						gate.resolve();
					},
				});
				// Release the lock however this ends — one bad print must not wedge
				// a printer for every document behind it.
				printing.then(gate.resolve, gate.resolve);
				await gate.promise;
			});

			if (!printing) {
				// Never spooled — the guard inside the lock fired. Nothing printed.
				registry.dequeue(device, task.id);
				return;
			}

			const result = await printing;
			if (result.outcome === "aborted") {
				// Engine stopped mid-flight — the physical outcome is unknowable, so
				// put the task back only if the engine is somehow still running (it
				// isn't, for abortAll; this just avoids losing the task either way).
				if (engine.running && engine.tasks.includes(task)) {
					task.status = "waiting";
					task.device = null;
				}
				registry.dequeue(device, task.id);
				return;
			}
		}

		// Discard the outcome if the job vanished (remote cancel) meanwhile.
		if (!engine.running || !engine.tasks.includes(task)) {
			registry.dequeue(device, task.id);
			return;
		}

		task.status = "printed";
		task.failureReason = null;
		markFilePrinted(task.jobId, task.fileId);
		registry.dequeue(device, task.id);
		console.log(`[Engine] printed ${task.id} on "${device}"`);
		await maybeCompleteJob(task.jobId);
	} catch (err) {
		registry.dequeue(device, task.id);
		await handleDispatchFailure(task, device, err);
	} finally {
		emit();
		schedule();
	}
}

// Withdraws a job's WAITING tasks — documents queued but not yet sent to any
// printer (a waiting task holds no registry slot, so there is nothing to
// unwind). In-flight tasks are untouched by design. Because the main process is
// single-threaded and dispatching claims a task synchronously (claimAndDispatch
// flips it to "printing" inside the same schedule() pass), a task is always
// EITHER still waiting — and safely removable here — or already in flight and
// left to finish: there is no window where a withdrawn document can also print.
// `sequentialOnly` limits the sweep to print-all batch tasks.
function withdrawWaitingTasks(jobId, { sequentialOnly = false } = {}) {
	const drop = new Set(
		engine.tasks.filter(
			(t) => t.jobId === jobId && t.status === "waiting" && (!sequentialOnly || t.sequential)
		)
	);
	if (drop.size === 0) return 0;
	engine.tasks = engine.tasks.filter((t) => !drop.has(t));
	return drop.size;
}

// Part 2: a failed document stops its print-all batch RIGHT THERE — the
// remaining queued documents are withdrawn. The next Print-all click re-issues
// every unprinted document, the failed one included — and since it sits
// earliest in document order, it is retried first, not skipped.
function haltSequentialBatch(task) {
	if (!task.sequential) return;
	const n = withdrawWaitingTasks(task.jobId, { sequentialOnly: true });
	if (n) console.log(`[Engine] batch for job ${task.jobId} halted after ${task.id} failed — ${n} doc(s) withdrawn`);
}

async function handleDispatchFailure(task, device, err) {
	console.warn(`[Engine] print failed for ${task.id} on "${device}":`, err.message);
	if (!engine.running || !engine.tasks.includes(task)) return; // job dropped meanwhile

	// A dismissed Print-to-PDF save dialog is operator-side, not a printer fault —
	// so it isn't recorded as an attempt (there's no bad printer to steer away
	// from) and it gets its own message. Everything after that is identical: it
	// stops the job's printing exactly like any other failure.
	const pdfCancelled = err.message === "pdf save cancelled";
	if (!pdfCancelled) {
		// Recorded so an operator-initiated retry is steered away from the printer
		// that just failed this document (schedule() passes it to choosePrinter as
		// `exclude`). It is NOT a retry counter — a failure is always permanent.
		task.attempts.push({ device, error: err.message, at: Date.now() });
	}

	task.status = "failed";
	task.failureReason = pdfCancelled ? "pdf-cancel" : "print";
	task.device = null;

	// The job is NEVER failed automatically, in either mode — not even when the
	// failed document is the job's only one. The refund PATCH belongs solely to
	// forceFailJob, the operator's explicit control.
	if (task.mode === "auto") {
		// Part 3: unattended printing stops for THIS job the moment a document
		// fails. There is no retry — a failure means paper, toner, a dismissed save
		// dialog or the printer itself needs a human, and the rest of the queue must
		// not keep feeding it. The job's remaining documents stay queued (held by
		// the pause) so resuming continues where it left off; the failed document
		// waits for the operator to retry it by hand.
		engine.autoPausedJobs.set(task.jobId, "failure");
		console.log(`[Engine] ${task.id} failed — automated printing paused for job ${task.jobId} (needs attention)`);
		toast(
			pdfCancelled
				? { kind: "pdf-cancel", jobId: task.jobId, fileName: task.fileName }
				: { kind: "auto-paused-failure", jobId: task.jobId, fileName: task.fileName, who: jobWho(getJobs().find((j) => j._id === task.jobId)) }
		);
	} else {
		// Manual print: the document is flagged and a print-all batch stops here
		// (its remaining documents are withdrawn — see haltSequentialBatch).
		console.log(`[Engine] ${task.id} failed permanently — awaiting operator (job left untouched)`);
		haltSequentialBatch(task);
		toast(
			pdfCancelled
				? { kind: "pdf-cancel", jobId: task.jobId, fileName: task.fileName }
				: { kind: "doc-failed-print", jobId: task.jobId, fileName: task.fileName }
		);
	}
	jobsChanged();
}

// ── backend transitions ──────────────────────────────────────────────────────

// Transitions a job to "printing" exactly once. Coalesces concurrent dispatches
// of the same job (two files on two printers) into one PATCH sequence.
//
// The backend only permits single-step transitions submitted → queued →
// printing. A job may still be "submitted" here: acknowledgement (submitted →
// queued) is fire-and-forget and can lag behind an operator's quick manual
// print. So step through "queued" first when needed — and if that PATCH is
// rejected because the ack already landed backend-side (our cache is stale),
// ignore it and let the "printing" step decide the real outcome.
function ensureJobPrinting(jobId) {
	if (engine.jobsMarkedPrinting.has(jobId)) return Promise.resolve(true);
	const inflight = engine.printingPatches.get(jobId);
	if (inflight) return inflight;

	const job = getJobs().find((j) => j._id === jobId);
	const current = engine.overrides.get(jobId) || job?.status;
	if (current === "printing") {
		engine.jobsMarkedPrinting.add(jobId);
		return Promise.resolve(true);
	}

	const promise = (async () => {
		// Try "printing" directly — works when the job is already "queued".
		let result = await updateJobStatus(jobId, "printing");

		// A "submitted" job can't jump straight to "printing" (acknowledgement to
		// "queued" is fire-and-forget and may lag an operator's quick print). The
		// local cache may not reflect the real status either, so don't trust it:
		// on any failure, step through "queued" and retry "printing".
		if (!result?.success) {
			console.warn(`[Engine] job ${jobId} → printing rejected (${result?.message}); stepping through queued`);
			const queued = await updateJobStatus(jobId, "queued");
			if (queued?.success) engine.overrides.set(jobId, "queued");
			result = await updateJobStatus(jobId, "printing");
		}

		if (result?.success) {
			engine.jobsMarkedPrinting.add(jobId);
			engine.overrides.set(jobId, "printing");
			jobsChanged();
			return true;
		}
		console.error(`[Engine] failed to set job ${jobId} printing:`, result?.message);
		return false;
	})().finally(() => engine.printingPatches.delete(jobId));

	engine.printingPatches.set(jobId, promise);
	return promise;
}

// Completes a job on the backend once every file is verified-printed.
async function maybeCompleteJob(jobId) {
	if (engine.jobsCompleting.has(jobId)) return;
	const job = getJobs().find((j) => j._id === jobId);
	if (!job) return;
	const fileIds = jobFileList(job).map((f) => f.fileId);
	if (fileIds.length === 0 || !fileIds.every((id) => isFilePrinted(jobId, id))) return;

	engine.jobsCompleting.add(jobId);
	const result = await updateJobStatus(jobId, "completed");
	if (result?.success) {
		console.log(`[Engine] job ${jobId} completed`);
		engine.overrides.set(jobId, "completed");
		finalizeJob(jobId, fileIds);
		jobsChanged();
	} else {
		console.error(`[Engine] failed to complete job ${jobId}:`, result?.message);
		engine.jobsCompleting.delete(jobId);
	}
}

// Marks a whole job failed on the backend (customer refund). Used by the
// permanent-print-failure path and the operator's banner force-fail.
async function autoFailJob(jobId) {
	if (engine.jobsFailing.has(jobId)) return false;
	engine.jobsFailing.add(jobId);

	const job = getJobs().find((j) => j._id === jobId);
	const current = engine.jobsMarkedPrinting.has(jobId)
		? "printing"
		: engine.overrides.get(jobId) || job?.status;

	const result = await markJobFailed(jobId, current);
	if (!result?.success) {
		console.error(`[Engine] failed to mark job ${jobId} failed:`, result?.message);
		engine.jobsFailing.delete(jobId);
		toast({ kind: "fail-report-error", jobId, who: jobWho(job) });
		return false;
	}

	console.warn(`[Engine] job ${jobId} marked failed (refund)`);
	engine.overrides.set(jobId, "failed");
	toast({ kind: "job-failed-print", jobId, who: jobWho(job) });
	finalizeJob(jobId, jobFileList(job).map((f) => f.fileId));
	jobsChanged();
	emit();
	return true;
}

// Terminal-state cleanup shared by complete/cancel/fail: drop tasks, delete
// cached files, prune progress.
function finalizeJob(jobId, fileIds) {
	dropJobTasks(jobId);
	pruneJobProgress(jobId);
	if (fileIds?.length) {
		files.deleteJobFiles(fileIds).catch((err) => console.error("[Engine] file cleanup failed:", err));
	}
	emit();
}

// ── SSE reconcile ────────────────────────────────────────────────────────────

function onJobsReconciled(jobs) {
	if (!engine.running) return;

	const byId = new Map(jobs.map((j) => [j._id, j]));

	// Drop local overrides the backend has caught up with (or whose jobs vanished).
	for (const [jobId, status] of [...engine.overrides]) {
		const job = byId.get(jobId);
		if (!job || job.status === status || !ACTIVE_STATUSES.has(job.status)) {
			engine.overrides.delete(jobId);
		}
	}

	// Drop tasks + guards for jobs that are gone or terminal. "Active" is
	// override-aware: a job we locally completed/failed/cancelled (backend not
	// yet confirmed over SSE) is already terminal for scheduling purposes.
	const effectiveStatus = (j) => engine.overrides.get(j._id) || j.status;
	const activeIds = new Set(jobs.filter((j) => ACTIVE_STATUSES.has(effectiveStatus(j))).map((j) => j._id));
	const trackedJobIds = new Set(engine.tasks.map((t) => t.jobId));
	engine.tasks = engine.tasks.filter((t) => activeIds.has(t.jobId));
	// Release printer-queue entries for jobs that just went terminal or vanished.
	for (const jobId of trackedJobIds) {
		if (!activeIds.has(jobId)) registry.dropJob(jobId);
	}
	for (const set of [engine.jobsMarkedPrinting, engine.jobsCompleting, engine.jobsFailing, engine.seenJobs]) {
		for (const jobId of [...set]) {
			if (!byId.has(jobId)) set.delete(jobId);
		}
	}
	// A job that's gone or terminal no longer needs attention.
	for (const jobId of [...engine.autoPausedJobs.keys()]) {
		if (!activeIds.has(jobId)) engine.autoPausedJobs.delete(jobId);
	}

	// Prune persisted progress for jobs no longer present.
	let progressChanged = false;
	for (const jobId of Object.keys(engine.printedFiles)) {
		if (!byId.has(jobId)) {
			delete engine.printedFiles[jobId];
			progressChanged = true;
		}
	}
	if (progressChanged) persistPrintedFiles();

	const activeJobs = jobs.filter((j) => ACTIVE_STATUSES.has(effectiveStatus(j)));

	if (!engine.initialized) {
		// First reconcile after start. Marking every active job "seen" here is what
		// stops the backlog printing itself the moment auto-print is armed later.
		engine.initialized = true;
		activeJobs.forEach((j) => engine.seenJobs.add(j._id));

		// Automated printing never resumes on its own. If it was armed when the app
		// last closed, ASK — with the number of jobs that would start printing
		// immediately, since some may have printed just before the app closed.
		if (!engine.autoPrint && store.get(AUTO_PRINT_ARMED_KEY) === true) {
			const pendingJobs = activeJobs.filter((j) =>
				jobFileList(j).some((f) => !isFilePrinted(j._id, f.fileId))
			).length;
			engine.resumePrompt = { pendingJobs };
			console.log(`[Engine] automated printing was on last session — asking to resume (${pendingJobs} job(s) pending)`);
		}
	} else if (engine.autoPrint) {
		// Auto-enqueue jobs that arrived while enabled.
		for (const job of activeJobs) {
			if (engine.seenJobs.has(job._id)) continue;
			engine.seenJobs.add(job._id);
			// Sequential, exactly like Print-all: one document at a printer at a
			// time, each routed by choosePrinter when its turn comes.
			addTasks(job, "auto", null, { sequential: true });
		}
	}

	schedule();
	emit();
}

// ── commands (IPC surface) ───────────────────────────────────────────────────

// Part 2 — "Print all" / "Print (n docs)". Moves the WHOLE job to "printing" on
// the backend, then queues every unprinted document as a SEQUENTIAL batch: the
// task list is the job's own state array, and the scheduler feeds the printer
// one document at a time — the next is sent only after the previous settles,
// never dumping the whole job into the Windows spool queue at once.
//   • dropdown printer chosen → every document goes to that device;
//   • plain click             → each document, when its turn comes, is routed to
//     the least-loaded printer of its matching service (registry.choosePrinter).
// A mid-batch failure flags that document (Part 1 rules — never fails the job)
// and STOPS the batch right there (haltSequentialBatch): the remaining
// documents are withdrawn. Clicking Print-all again re-issues every unprinted
// document — the failed one first, in document order — via addTasks' explicit
// re-issue path.
async function printJob(jobId, deviceName = null) {
	const job = getJobs().find((j) => j._id === jobId);
	if (!job) return { success: false, message: "job not found" };

	const ok = await ensureJobPrinting(jobId);
	if (!ok) {
		toast({ kind: "job-printing-failed", jobId, who: jobWho(job) });
		return { success: false, message: "could not move the job to printing" };
	}

	addTasks(job, "manual", deviceName, { explicit: true, sequential: true });
	schedule();
	return { success: true };
}

// The Stop button (shown while a print-all batch is running). Withdraws every
// document of the job still WAITING; the document currently at the printer is
// deliberately left to finish — its outcome (printed / failed) lands normally,
// so no page is ever half-tracked. Race-free by construction: waiting tasks
// are removed synchronously on the main thread, and dispatch claims tasks
// synchronously, so a document is either withdrawn before it ever reaches a
// printer or already in flight and allowed to complete — never both, never
// neither. Clicking Print-all afterwards re-issues the withdrawn documents.
function stopJobBatch(jobId) {
	const n = withdrawWaitingTasks(jobId); // ALL waiting docs of the job, batch or not
	console.log(`[Engine] stop requested for job ${jobId} — ${n} queued doc(s) withdrawn, in-flight doc (if any) finishing`);
	emit();
	return { success: true, withdrawn: n };
}

// Part 1 — the per-document Print button. Clicking it moves the WHOLE job to
// "printing" on the backend up front, then queues just this document: to the
// printer chosen from the dropdown, or (no choice) to the least-loaded printer
// of the service that matches the document's settings.
async function printFile(jobId, fileId, deviceName = null) {
	const job = getJobs().find((j) => j._id === jobId);
	if (!job) return { success: false, message: "job not found" };

	const ok = await ensureJobPrinting(jobId);
	if (!ok) {
		// Nothing was queued, so the UI would otherwise show no reaction at all.
		toast({ kind: "job-printing-failed", jobId, who: jobWho(job) });
		return { success: false, message: "could not move the job to printing" };
	}

	addTasks(job, "manual", deviceName, { onlyFileId: fileId, explicit: true });
	schedule();
	return { success: true };
}

function setPaused(paused) {
	engine.paused = !!paused;
	if (!engine.paused) schedule();
	emit();
	return { success: true };
}

function setAutoPrint(enabled) {
	engine.autoPrint = !!enabled;
	// The on/off STATE is never restored (see start()); only the fact that it was
	// armed is remembered, so the next launch can offer to resume. Switching it
	// off is a deliberate disarm and forgets that.
	if (engine.autoPrint) store.set(AUTO_PRINT_ARMED_KEY, true);
	else store.remove(AUTO_PRINT_ARMED_KEY);
	if (engine.autoPrint) {
		// Enqueue the current backlog immediately (chosen behavior).
		const activeJobs = getJobs().filter((j) => ACTIVE_STATUSES.has(j.status));
		for (const job of activeJobs) {
			engine.seenJobs.add(job._id);
			// Sequential, exactly like Print-all: one document at a printer at a
			// time, each routed by choosePrinter when its turn comes.
			addTasks(job, "auto", null, { sequential: true });
		}
		schedule();
	} else {
		engine.paused = false; // existing queue keeps draining; new jobs won't enqueue
		schedule();
	}
	emit();
	return { success: true };
}

// The operator's answer to "automated printing was on last time — resume it?".
// Yes re-arms it exactly as if they'd flipped the switch themselves, which also
// enqueues whatever is currently unprinted. No leaves it off and forgets that it
// was ever armed, so the next launch doesn't ask again.
// Per-job master switch for automated printing (Part 3). Pausing holds only this
// job's automated documents — the rest of the queue keeps printing. While paused
// the job's manual controls come back, which is how the operator intervenes on a
// job the engine parked after a failure. Resuming continues from where it
// stopped; a document that already failed is NOT retried by this — the operator
// retries it explicitly.
function setJobAutoPaused(jobId, paused) {
	if (paused) {
		// An operator pause must never downgrade a failure park — the job still
		// needs attention either way.
		if (!engine.autoPausedJobs.has(jobId)) engine.autoPausedJobs.set(jobId, "operator");
	} else {
		engine.autoPausedJobs.delete(jobId);
		// Re-arm the job's automated queue. Its held documents may have been
		// withdrawn while it was parked (the Stop control, a decline that was
		// refused, …), and onJobsReconciled will NOT re-add them because the job is
		// already in seenJobs — so resuming has to do it, or the remaining
		// documents would be stranded with no way back into the auto queue.
		// addTasks is non-explicit here: existing tasks (including the failed one)
		// are left exactly as they are, and printed documents are skipped.
		if (engine.autoPrint) {
			const job = getJobs().find((j) => j._id === jobId);
			if (job) addTasks(job, "auto", null, { sequential: true });
		}
	}
	console.log(`[Engine] automated printing ${paused ? "paused" : "resumed"} for job ${jobId}`);
	schedule();
	emit();
	return { success: true };
}

function resolveResumePrompt(accept) {
	if (!engine.resumePrompt) return { success: true };
	engine.resumePrompt = null;

	if (accept) {
		console.log("[Engine] operator resumed automated printing");
		setAutoPrint(true); // arms it, enqueues the backlog, emits
	} else {
		console.log("[Engine] operator declined to resume automated printing");
		store.remove(AUTO_PRINT_ARMED_KEY);
		emit();
	}
	return { success: true };
}

async function declineJob(jobId) {
	const job = getJobs().find((j) => j._id === jobId);

	// Effective backend status. Once the engine advances a job to "printing"
	// (auto or manual dispatch calls ensureJobPrinting), that PATCH has already
	// landed server-side — even if nothing is in a printer queue right now
	// (between documents, or waiting for a printer).
	const current = engine.jobsMarkedPrinting.has(jobId)
		? "printing"
		: engine.overrides.get(jobId) || job?.status;

	// The backend state machine forbids printing → cancelled (409). The only
	// terminals left are completed and failed — and "failed" refunds the customer,
	// which is a materially different decision from cancelling. So refuse here
	// and report why: the UI explains it and offers the refund explicitly. Nothing
	// is dropped or PATCHed on this path — the job is left exactly as it was.
	if (current === "printing") {
		console.log(`[Engine] decline refused for job ${jobId}: already printing`);
		return {
			success: false,
			reason: "already-printing",
			message: "This job has already started printing, so it can no longer be cancelled.",
		};
	}

	dropJobTasks(jobId);
	emit();

	const result = await updateJobStatus(jobId, "cancelled");
	if (result?.success) {
		engine.overrides.set(jobId, "cancelled");
		finalizeJob(jobId, jobFileList(job).map((f) => f.fileId));
		jobsChanged();
		return { success: true };
	}
	console.error(`[Engine] failed to decline job ${jobId}:`, result?.message);
	return { success: false, message: result?.message || "request failed" };
}

// `force` steps a never-printed job through the backend's required
// queued → printing → completed sequence.
async function completeJob(jobId, { force = false } = {}) {
	const job = getJobs().find((j) => j._id === jobId);
	if (force) {
		const printing = await updateJobStatus(jobId, "printing");
		if (!printing?.success) return { success: false, message: printing?.message || "printing transition failed" };
	}
	const result = await updateJobStatus(jobId, "completed");
	if (result?.success) {
		engine.overrides.set(jobId, "completed");
		finalizeJob(jobId, jobFileList(job).map((f) => f.fileId));
		jobsChanged();
		return { success: true };
	}
	return { success: false, message: result?.message || "request failed" };
}

// Operator's per-document failure banner: force-fail the whole job.
async function forceFailJob(jobId) {
	const ok = await autoFailJob(jobId);
	return ok ? { success: true } : { success: false, message: "request failed" };
}

// Download-failure path (files.js → ipc handleJobFailed): the job was already
// marked failed on the backend; just clean up engine state.
function dropJob(jobId) {
	engine.overrides.set(jobId, "failed");
	dropJobTasks(jobId);
	pruneJobProgress(jobId);
	jobsChanged();
	emit();
}

// ── lifecycle ────────────────────────────────────────────────────────────────

function init({ getMainWindow, onSnapshot, onToast, onJobsChanged }) {
	_getMainWindow = getMainWindow;
	_onSnapshot = onSnapshot;
	_onToast = onToast;
	_onJobsChanged = onJobsChanged;
	files.addStatusListener((fileId, status) => {
		if (engine.running && status === "ready") schedule();
	});
	// Any change to a printer's queue (dispatch, spool id, sweep) re-publishes the
	// engine snapshot, so the renderer's queue view is always live.
	registry.setChangeNotifier(() => emit());
}

function start() {
	if (engine.running) return;
	console.log("[Engine] starting");
	engine.running = true;
	// Automated printing NEVER resumes by itself: an app restart (or a fresh
	// login) always comes up with it off. It prints unattended and costs the
	// customer money, so re-arming it must be a deliberate act by an operator who
	// is actually present. If it WAS armed last session the first reconcile offers
	// to resume it (see onJobsReconciled / resolveResumePrompt).
	// "autoPrint" is the legacy key from builds that silently restored the state —
	// dropped so it can never leak back in.
	engine.autoPrint = false;
	engine.resumePrompt = null;
	store.remove("autoPrint");
	engine.paused = false;
	engine.initialized = false;
	loadPrintedFiles();
	// Populate the registry, then take a first reading of every printer's real
	// spool queue so load balancing starts from the machine's actual state
	// (including work queued by other apps) rather than from zero.
	refreshRouting(true).then(() => reconcilePrinterQueues());
	_routingTimer = setInterval(() => refreshRouting(), ROUTING_POLL_MS);
	if (_routingTimer.unref) _routingTimer.unref();
	emit();
}

function stop() {
	if (!engine.running) return;
	console.log("[Engine] stopping");
	engine.running = false;
	spooler.abortAll();
	if (_routingTimer) {
		clearInterval(_routingTimer);
		_routingTimer = null;
	}
	engine.tasks = [];
	_spoolLocks.clear();
	registry.reset();
	engine.resumePrompt = null;
	// Disarmed in memory on logout too — but the persisted "was armed" marker is
	// deliberately left alone, so logging back in offers to resume just like a
	// restart does.
	engine.autoPrint = false;
	engine.paused = false;
	engine.initialized = false;
	engine.seenJobs.clear();
	engine.autoPausedJobs.clear();
	engine.jobsMarkedPrinting.clear();
	engine.jobsCompleting.clear();
	engine.jobsFailing.clear();
	engine.printingPatches.clear();
	engine.overrides.clear();
	emit();
}

module.exports = {
	init,
	start,
	stop,
	onJobsReconciled,
	applyOverrides,
	getSnapshot,
	refreshRouting,
	reconcilePrinterQueues,
	migrateProgress,
	printJob,
	printFile,
	stopJobBatch,
	setPaused,
	setAutoPrint,
	resolveResumePrompt,
	setJobAutoPaused,
	declineJob,
	completeJob,
	forceFailJob,
	dropJob,
};
