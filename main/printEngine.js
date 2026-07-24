const {
	fetchServices,
	fetchPrinters,
	updateJobStatus,
	markJobFailed,
} = require("./api");
const { listPrinters } = require("./printers");
const files = require("./files");
const spooler = require("./spooler");
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
//    a free printer among that service's printers.
//  - A printer holds AT MOST one of our files at a time (the Windows spooler is
//    never used as a queue). Busy/offline candidates → the task waits, visibly.
//  - "Printed" means verified against the Windows spooler (files.printAndVerify),
//    not merely spooled. A real print failure is retried once (preferring a
//    different candidate printer); a second failure auto-fails the WHOLE job on
//    the backend (customer refund) — money is involved, silent loss is not OK.
//    Exceptions that never auto-fail: a cancelled Print-to-PDF save dialog and
//    routing gaps (operator-side config issues).
// ─────────────────────────────────────────────────────────────────────────────

const ACTIVE_STATUSES = new Set(["draft", "submitted", "queued", "processing", "printing"]);
const ROUTING_POLL_MS = 20000;
const PRINTED_STORE_KEY = "printedFiles";
const MAX_ATTEMPTS = 2; // 1 initial + 1 automatic retry

function isPdfDevice(name) {
	return /print to pdf/i.test(name || "");
}

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

// A document routes to a printer through its service: match the file's settings
// to a service's keys. File settings use sidedness "none"|"long"|"short";
// service keys use a boolean (double-sided or not).
function matchesService(settings = {}, keys = {}) {
	return (
		keys.pageType === settings.pageType &&
		!!keys.color === !!settings.color &&
		!!keys.sidedness === (!!settings.sidedness && settings.sidedness !== "none")
	);
}

// ── engine state ─────────────────────────────────────────────────────────────
const engine = {
	running: false,
	autoPrint: false,
	paused: false,
	requeuePrompt: null, // null | { jobIds: [...] }

	// Routing table.
	services: [],
	registeredPrinters: [],
	localPrinters: [], // online local printers [{name, displayName}]
	routingLoaded: false,

	// device -> { taskId, jobId, fileId, phase: "printing"|"verifying" }
	slots: new Map(),

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

	seenJobs: new Set(), // jobIds already considered for auto-enqueue
	initialized: false, // first reconcile handled (requeue prompt decided)
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
		};
		if (
			(task.status === "waiting" || task.status === "printing" || task.status === "verifying") &&
			!queuedJobIds.includes(task.jobId)
		) {
			queuedJobIds.push(task.jobId);
		}
	}
	const printers = {};
	for (const [device, slot] of engine.slots) {
		printers[device] = { jobId: slot.jobId, fileId: slot.fileId, phase: slot.phase };
	}
	return {
		running: engine.running,
		autoPrint: engine.autoPrint,
		paused: engine.paused,
		routingLoaded: engine.routingLoaded,
		autoRouteReady: computeAutoRouteReady(),
		requeuePrompt: engine.requeuePrompt,
		queuedJobIds,
		printedFiles: engine.printedFiles,
		files: fileMap,
		printers,
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
	} catch (err) {
		console.error("[Engine] routing refresh failed:", err);
	} finally {
		engine.routingLoaded = true;
		schedule();
		emit();
	}
}

// Resolves a service-printer entry to the registered printer record.
function resolveRegistered(entry) {
	const id = typeof entry.printer === "string" ? entry.printer : entry.printer?._id;
	return (
		engine.registeredPrinters.find((p) => p._id === id) ||
		(typeof entry.printer === "object" ? entry.printer : null)
	);
}

// Ordered candidate device names for a task, or a wait reason.
// Auto mode: the matched service's printers marked useAuto (PDF pseudo-printers
// excluded — a Save dialog must never block the unattended queue).
// Manual mode: ALL of the service's printers. Override: exactly that device.
function resolveCandidates(task) {
	const onlineNames = new Set(engine.localPrinters.map((p) => p.name));

	if (task.overrideDevice) {
		if (isPdfDevice(task.overrideDevice) || onlineNames.has(task.overrideDevice)) {
			return { candidates: [task.overrideDevice], waitReason: null };
		}
		return { candidates: [], waitReason: "no-online-printer" };
	}

	const service = engine.services.find((s) => !s.isDisabled && matchesService(task.settings, s.keys));
	if (!service) return { candidates: [], waitReason: "route" };

	const configured = [];
	for (const entry of service.printers || []) {
		if (task.mode === "auto" && !entry.useAuto) continue;
		const reg = resolveRegistered(entry);
		if (!reg || reg.isDisabled) continue;
		if (task.mode === "auto" && isPdfDevice(reg.name)) continue;
		configured.push(reg.name);
	}
	if (configured.length === 0) return { candidates: [], waitReason: "route" };

	const online = configured.filter((name) => onlineNames.has(name));
	if (online.length === 0) return { candidates: [], waitReason: "no-online-printer" };
	return { candidates: online, waitReason: null };
}

// Gate for the auto-print toggle: at least one enabled service has an automated
// printer that is registered and enabled. Online-ness deliberately not required
// (a printer being briefly off shouldn't flip the toggle's availability).
function computeAutoRouteReady() {
	return engine.services.some(
		(s) =>
			!s.isDisabled &&
			(s.printers || []).some((entry) => {
				if (!entry.useAuto) return false;
				const reg = resolveRegistered(entry);
				return reg && !reg.isDisabled && !isPdfDevice(reg.name);
			})
	);
}

// ── task helpers ─────────────────────────────────────────────────────────────

function findTask(jobId, fileId) {
	return engine.tasks.find((t) => t.jobId === jobId && t.fileId === fileId);
}

// Adds (or refreshes) tasks for a job's unprinted files. Explicit commands
// reset failed tasks and apply overrides; auto-enqueue leaves existing tasks
// alone. In-flight tasks are never touched.
function addTasks(job, mode, overrideDevice = null, { onlyFileId = null, explicit = false } = {}) {
	let added = false;
	for (const file of jobFileList(job)) {
		if (onlyFileId && file.fileId !== onlyFileId) continue;
		if (isFilePrinted(job._id, file.fileId)) continue;

		const existing = findTask(job._id, file.fileId);
		if (existing) {
			if (!explicit) continue;
			if (existing.status === "printing" || existing.status === "verifying") continue;
			// Re-issue: clear failure state, apply the new mode/override.
			existing.status = "waiting";
			existing.waitReason = null;
			existing.failureReason = null;
			existing.attempts = [];
			existing.mode = mode;
			existing.overrideDevice = overrideDevice;
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
// notices (the task is no longer listed) and discards the outcome.
function dropJobTasks(jobId) {
	engine.tasks = engine.tasks.filter((t) => t.jobId !== jobId);
}

// ── scheduler ────────────────────────────────────────────────────────────────

// One synchronous pass: assign free printers to waiting tasks in FIFO order.
// Slots are claimed synchronously before any await, so re-entrancy is safe.
// Triggers: task added, slot freed, routing refreshed, file ready, reconcile,
// unpause.
function schedule() {
	if (!engine.running || engine.paused) return;

	for (const task of engine.tasks) {
		if (task.status !== "waiting") continue;
		if (task.notBefore && task.notBefore > Date.now()) continue; // backend backoff

		if (!files.isReady(task.fileId)) {
			task.waitReason = "downloading";
			continue;
		}

		const { candidates, waitReason } = resolveCandidates(task);
		if (waitReason) {
			task.waitReason = waitReason;
			continue;
		}

		// Retry policy prefers a candidate we haven't tried for this task.
		const tried = new Set(task.attempts.map((a) => a.device));
		const ordered = [...candidates.filter((d) => !tried.has(d)), ...candidates.filter((d) => tried.has(d))];
		const free = ordered.find((d) => !engine.slots.has(d));
		if (!free) {
			task.waitReason = "no-free-printer";
			continue;
		}

		console.log(`[Engine] dispatch ${task.id} → "${free}" (mode=${task.mode}${task.overrideDevice ? ", override" : ""})`);
		claimAndDispatch(task, free);
	}
	emit();
}

function claimAndDispatch(task, device) {
	task.status = "printing";
	task.waitReason = null;
	task.device = device;
	const slot = { taskId: task.id, jobId: task.jobId, fileId: task.fileId, phase: "printing" };
	engine.slots.set(device, slot);

	dispatch(task, device, slot).catch((err) => {
		// dispatch handles its own failures; this only guards programmer error.
		console.error(`[Engine] dispatch crashed for ${task.id}:`, err);
	});
}

async function dispatch(task, device, slot) {
	try {
		// Job → "printing" on the backend before its first document prints.
		const ok = await ensureJobPrinting(task.jobId);
		if (!ok) {
			// Backend refused/unreachable — back off so schedule() doesn't spin a
			// tight PATCH loop; the routing poll re-runs it every 20s.
			if (engine.tasks.includes(task)) {
				task.status = "waiting";
				task.device = null;
				task.notBefore = Date.now() + 15000;
			}
			return;
		}

		// SSE race guard: the job may have been cancelled while we PATCHed.
		if (!engine.running || !engine.tasks.includes(task)) return;

		if (isPdfDevice(device)) {
			// Manual override to Print-to-PDF: Save dialog + copy. Never auto-fails.
			await files.savePdfCopy(task.fileId, task.fileName);
		} else {
			const result = await files.printAndVerify(task.fileId, task.settings, device, task.fileName, {
				onPhase: () => {
					task.status = "verifying";
					slot.phase = "verifying";
					emit();
				},
			});
			if (result.outcome === "aborted") {
				// Engine stopped (or the tracker was superseded) mid-flight — the
				// outcome is unknowable; put the task back if it still exists.
				if (engine.running && engine.tasks.includes(task)) {
					task.status = "waiting";
					task.device = null;
				}
				return;
			}
		}

		// Discard the outcome if the job vanished (remote cancel) meanwhile.
		if (!engine.running || !engine.tasks.includes(task)) return;

		task.status = "printed";
		markFilePrinted(task.jobId, task.fileId);
		console.log(`[Engine] printed ${task.id} on "${device}"`);
		await maybeCompleteJob(task.jobId);
	} catch (err) {
		await handleDispatchFailure(task, device, err);
	} finally {
		engine.slots.delete(device);
		emit();
		schedule();
	}
}

async function handleDispatchFailure(task, device, err) {
	console.warn(`[Engine] print failed for ${task.id} on "${device}":`, err.message);
	if (!engine.running || !engine.tasks.includes(task)) return; // job dropped meanwhile

	if (err.message === "pdf save cancelled") {
		// Operator dismissed the Save dialog — operator-side, never a refund.
		task.status = "failed";
		task.failureReason = "pdf-cancel";
		toast({ kind: "pdf-cancel", jobId: task.jobId, fileName: task.fileName });
		return;
	}

	task.attempts.push({ device, error: err.message, at: Date.now() });

	if (task.attempts.length < MAX_ATTEMPTS) {
		// One automatic retry — schedule() prefers a printer we haven't tried.
		console.log(`[Engine] retrying ${task.id} (attempt ${task.attempts.length + 1}/${MAX_ATTEMPTS})`);
		task.status = "waiting";
		task.waitReason = null;
		task.device = null;
		return;
	}

	// Permanent print failure → the whole job fails (customer refund).
	task.status = "failed";
	task.failureReason = "print";
	await autoFailJob(task.jobId);
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
	engine.tasks = engine.tasks.filter((t) => activeIds.has(t.jobId));
	for (const set of [engine.jobsMarkedPrinting, engine.jobsCompleting, engine.jobsFailing, engine.seenJobs]) {
		for (const jobId of [...set]) {
			if (!byId.has(jobId)) set.delete(jobId);
		}
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
		// First reconcile after start: never auto-print leftovers silently — the
		// operator decides via the requeue prompt (files may have printed while
		// the app was closed).
		engine.initialized = true;
		activeJobs.forEach((j) => engine.seenJobs.add(j._id));
		if (engine.autoPrint) {
			const leftovers = activeJobs
				.filter((j) => jobFileList(j).some((f) => !isFilePrinted(j._id, f.fileId)))
				.map((j) => j._id);
			if (leftovers.length) engine.requeuePrompt = { jobIds: leftovers };
		}
	} else if (engine.autoPrint) {
		// Auto-enqueue jobs that arrived while enabled.
		for (const job of activeJobs) {
			if (engine.seenJobs.has(job._id)) continue;
			engine.seenJobs.add(job._id);
			addTasks(job, "auto");
		}
	}

	schedule();
	emit();
}

// ── commands (IPC surface) ───────────────────────────────────────────────────

function printJob(jobId, deviceName = null) {
	const job = getJobs().find((j) => j._id === jobId);
	if (!job) return { success: false, message: "job not found" };
	addTasks(job, "manual", deviceName, { explicit: true });
	schedule();
	return { success: true };
}

function printFile(jobId, fileId, deviceName = null) {
	const job = getJobs().find((j) => j._id === jobId);
	if (!job) return { success: false, message: "job not found" };
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
	store.set("autoPrint", engine.autoPrint);
	if (engine.autoPrint) {
		// Enqueue the current backlog immediately (chosen behavior).
		const activeJobs = getJobs().filter((j) => ACTIVE_STATUSES.has(j.status));
		for (const job of activeJobs) {
			engine.seenJobs.add(job._id);
			addTasks(job, "auto");
		}
		schedule();
	} else {
		engine.paused = false; // existing queue keeps draining; new jobs won't enqueue
		schedule();
	}
	emit();
	return { success: true };
}

function resolveRequeue(accept) {
	const prompt = engine.requeuePrompt;
	engine.requeuePrompt = null;
	if (prompt) {
		for (const jobId of prompt.jobIds) {
			const job = getJobs().find((j) => j._id === jobId);
			if (job) addTasks(job, "auto");
		}
		// "Not now" keeps the queue but paused — the operator reviews first.
		engine.paused = !accept;
		schedule();
	}
	emit();
	return { success: true };
}

async function declineJob(jobId) {
	dropJobTasks(jobId);
	emit();

	const job = getJobs().find((j) => j._id === jobId);
	// Effective backend status. Once the engine advances a job to "printing"
	// (auto or manual dispatch calls ensureJobPrinting), that PATCH has already
	// landed server-side — even if no file is in a printer slot right now
	// (between documents, or waiting for a free printer).
	const current = engine.jobsMarkedPrinting.has(jobId)
		? "printing"
		: engine.overrides.get(jobId) || job?.status;

	// The backend state machine forbids printing → cancelled (returns 409). A job
	// already in "printing" can only terminate as failed/completed, so declining
	// it takes the printing → failed path — the SAME customer refund a cancel
	// triggers (issueRefund + moveJobToHistory), just the terminal the state
	// machine allows. A not-yet-printing job (submitted/queued) cancels as before.
	const terminal = current === "printing" ? "failed" : "cancelled";
	const result = await updateJobStatus(jobId, terminal);

	if (result?.success) {
		engine.overrides.set(jobId, terminal);
		finalizeJob(jobId, jobFileList(job).map((f) => f.fileId));
		jobsChanged();
		return { success: true };
	}
	console.error(`[Engine] failed to decline job ${jobId} (→ ${terminal}):`, result?.message);
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
}

function start() {
	if (engine.running) return;
	console.log("[Engine] starting");
	engine.running = true;
	engine.autoPrint = store.get("autoPrint") === true;
	engine.paused = false;
	engine.initialized = false;
	loadPrintedFiles();
	refreshRouting(true);
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
	engine.slots.clear();
	engine.requeuePrompt = null;
	engine.paused = false;
	engine.initialized = false;
	engine.seenJobs.clear();
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
	migrateProgress,
	printJob,
	printFile,
	setPaused,
	setAutoPrint,
	resolveRequeue,
	declineJob,
	completeJob,
	forceFailJob,
	dropJob,
};
