import { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import ConfirmDialog from "./components/ConfirmDialog";
import { collectBlockedKeys } from "./jobUtils";

// Thin mirror of the main-process print engine. ALL orchestration — service
// routing, the per-printer queue, spooler verification, retries, backend
// status transitions, file cleanup, persisted progress — lives in main
// (main/printEngine.js). This context only:
//   1. mirrors the engine's state snapshot (engine:state),
//   2. exposes command wrappers over IPC,
//   3. renders engine notifications (engine:toast) and the requeue dialog.

const EMPTY_SNAPSHOT = {
	running: false,
	autoPrint: false,
	paused: false,
	routingLoaded: false,
	autoRouteReady: false,
	requeuePrompt: null,
	queuedJobIds: [],
	printedFiles: {},
	files: {},
	printers: {},
};

// Legacy localStorage progress (pre-engine builds) — pushed to main once, then
// removed. Safe to delete this block after a release cycle.
const LEGACY_PROGRESS_KEY = "clickprint:printedFiles";

// Copy for the engine's semantic toast events.
function toastMessage({ kind, who, fileName }) {
	switch (kind) {
		case "job-failed-print":
			return `Job (${who}) marked failed — a document couldn't be printed. The customer will be refunded.`;
		case "job-failed-download":
			return `Job (${who}) failed — files couldn't be downloaded.`;
		// A manually-printed document failed. The job is deliberately left open —
		// the operator retries, or fails the job explicitly from its failure box.
		case "doc-failed-print":
			return `“${fileName}” couldn't be printed. The job is still open — retry it, or mark the job as failed.`;
		case "pdf-cancel":
			return `Saving “${fileName}” as PDF was cancelled. To cancel the job, use the Decline Job button.`;
		case "fail-report-error":
			return "Couldn't mark the job as failed — please try again.";
		// The click never got as far as queueing anything: the job couldn't be
		// moved to "printing" on the backend.
		case "job-printing-failed":
			return `Couldn't start job (${who}) — the server wouldn't accept it. Check your connection and try again.`;
		default:
			return null;
	}
}

const AutoPrintContext = createContext(null);

export function AutoPrintProvider({ children }) {
	const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);

	// Seed (for a late mount) + live subscription.
	useEffect(() => {
		let active = true;
		window.electronAPI.getEngineState()
			.then((s) => { if (active && s) setSnapshot(s); })
			.catch(() => {});
		const unsubscribe = window.electronAPI.onEngineState((s) => setSnapshot(s));
		return () => {
			active = false;
			if (unsubscribe) unsubscribe();
		};
	}, []);

	// One-time migration of pre-engine print progress out of localStorage.
	useEffect(() => {
		try {
			const raw = localStorage.getItem(LEGACY_PROGRESS_KEY);
			if (!raw) return;
			const parsed = JSON.parse(raw);
			window.electronAPI.migratePrintProgress(parsed)
				.then(() => localStorage.removeItem(LEGACY_PROGRESS_KEY))
				.catch(() => {});
		} catch {
			localStorage.removeItem(LEGACY_PROGRESS_KEY);
		}
	}, []);

	// ── failure alert sound ─────────────────────────────────────────────────────
	// Sounded when a document becomes BLOCKED — a failed print, a cancelled PDF
	// save, or a routing gap (getBlockedReason). Deliberately NOT tied to the
	// job-level "failed" PATCH: that is the operator's own deliberate action and
	// needs no alerting. This lives here rather than in the document card so a
	// failure is heard even when its job isn't the one selected on screen.
	const errorSoundRef = useRef(null);
	const blockedKeysRef = useRef(null); // null until the first snapshot is seen

	useEffect(() => {
		let cancelled = false;
		let objectUrl = null;

		// Same blob-URL approach as the new-job "pop" (JobsContext): playing the
		// file straight from its URL fails in Electron with
		// ERR_CACHE_OPERATION_NOT_SUPPORTED.
		fetch("sounds/error-popup.mp3")
			.then((res) => res.blob())
			.then((blob) => {
				if (cancelled) return;
				objectUrl = URL.createObjectURL(blob);
				const sound = new Audio(objectUrl);
				sound.volume = 0.7;
				errorSoundRef.current = sound;
			})
			.catch((err) => console.warn("[Renderer] failed to load error sound:", err.message));

		return () => {
			cancelled = true;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, []);

	useEffect(() => {
		const current = collectBlockedKeys(snapshot);
		const previous = blockedKeysRef.current;
		blockedKeysRef.current = current;

		// First snapshot only seeds the baseline — documents already failed when
		// the dashboard mounts (e.g. after a restart) must not sound an alert.
		if (previous === null) return;

		// Fire once per burst, however many documents newly failed.
		let isNew = false;
		for (const key of current) {
			if (!previous.has(key)) {
				isNew = true;
				break;
			}
		}
		if (!isNew) return;

		const sound = errorSoundRef.current;
		if (!sound) return;
		sound.currentTime = 0;
		sound.play().catch((err) => console.warn("[Renderer] error sound blocked:", err.message));
	}, [snapshot]);

	// ── toasts (engine notifications) ───────────────────────────────────────────
	const [toasts, setToasts] = useState([]);
	const dismissToast = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);

	useEffect(() => {
		return window.electronAPI.onEngineToast((payload) => {
			const message = toastMessage(payload || {});
			if (!message) return;
			const id = Date.now() + Math.random();
			setToasts((t) => [...t, { id, message }]);
			setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
		});
	}, []);

	// ── derived state ───────────────────────────────────────────────────────────
	const { autoPrint, paused, queuedJobIds, printedFiles, files: fileStates } = snapshot;

	const isFilePrinted = useCallback(
		(jobId, fileId) => !!printedFiles[jobId]?.[fileId],
		[printedFiles]
	);

	const isFileFailed = useCallback(
		(jobId, fileId) => fileStates[jobId]?.[fileId]?.status === "failed",
		[fileStates]
	);

	// Per-job map of failed fileIds (shape kept from the old context: truthy per file).
	const failedFilesFor = useCallback(
		(jobId) => {
			const out = {};
			for (const [fileId, state] of Object.entries(fileStates[jobId] || {})) {
				if (state.status === "failed") out[fileId] = state.failureReason || true;
			}
			return out;
		},
		[fileStates]
	);

	// Any of the job's documents queued or in flight — locks destructive actions
	// and drives the Print button's busy state.
	const jobBusy = useCallback(
		(jobId) => {
			const states = Object.values(fileStates[jobId] || {});
			return states.some((s) => s.status === "waiting" || s.status === "printing" || s.status === "verifying");
		},
		[fileStates]
	);

	const jobPrintingNow = useCallback(
		(jobId) => {
			const states = Object.values(fileStates[jobId] || {});
			return states.some((s) => s.status === "printing" || s.status === "verifying");
		},
		[fileStates]
	);

	// Documents queued but not yet at a printer — what the Stop button withdraws.
	// While true, the header's Print-all control renders as Stop.
	const jobHasQueuedDocs = useCallback(
		(jobId) => Object.values(fileStates[jobId] || {}).some((s) => s.status === "waiting"),
		[fileStates]
	);

	// Queue-position line for the jobs list.
	const queueInfoFor = useCallback(
		(jobId) => {
			const idx = queuedJobIds.indexOf(jobId);
			if (idx === -1) return null;
			if (jobPrintingNow(jobId)) return { state: "printing", place: idx };
			const states = Object.values(fileStates[jobId] || {});
			const allBlocked =
				states.length > 0 &&
				states.every(
					(s) =>
						s.status !== "waiting" ||
						s.waitReason === "no-free-printer" ||
						s.waitReason === "no-online-printer" ||
						s.waitReason === "route"
				) &&
				states.some((s) => s.status === "waiting");
			if (paused) return { state: "paused", place: idx };
			if (allBlocked) return { state: "waiting", place: idx };
			return { state: "queued", place: idx };
		},
		[queuedJobIds, paused, fileStates, jobPrintingNow]
	);

	// ── commands ────────────────────────────────────────────────────────────────
	const setPaused = useCallback(
		(value) => {
			const next = typeof value === "function" ? value(snapshot.paused) : value;
			window.electronAPI.setQueuePaused(!!next);
		},
		[snapshot.paused]
	);

	const enableAutoPrint = useCallback(() => window.electronAPI.setAutoPrint(true), []);
	const disableAutoPrint = useCallback(() => window.electronAPI.setAutoPrint(false), []);

	const printFileManual = useCallback(
		(job, file, deviceName) => window.electronAPI.printJobFile(job._id, file.fileId, deviceName),
		[]
	);
	const printAllManual = useCallback(
		(job, deviceName) => window.electronAPI.printJob(job._id, deviceName),
		[]
	);
	// Stop a running print-all: queued docs withdrawn, in-flight doc finishes.
	const stopPrintJob = useCallback((jobId) => window.electronAPI.stopPrintJob(jobId), []);

	const failJob = useCallback((job) => window.electronAPI.markJobFailed(job._id), []);
	const declineJob = useCallback((jobId) => window.electronAPI.declineJob(jobId), []);
	const completeJob = useCallback((jobId, opts) => window.electronAPI.completeJob(jobId, opts), []);

	const refreshPrinterState = useCallback(() => window.electronAPI.refreshRouting(), []);

	const value = {
		autoPrintEnabled: autoPrint,
		paused,
		setPaused,
		queueCount: queuedJobIds.length,
		queuedJobIds,
		printedFiles,
		fileStates,
		isFilePrinted,
		isFileFailed,
		failedFilesFor,
		jobBusy,
		jobPrintingNow,
		jobHasQueuedDocs,
		stopPrintJob,
		queueInfoFor,
		enableAutoPrint,
		disableAutoPrint,
		printFileManual,
		printAllManual,
		failJob,
		declineJob,
		completeJob,
		autoRouteReady: snapshot.autoRouteReady,
		printersReady: snapshot.routingLoaded,
		refreshPrinterState,
	};

	const requeueCount = snapshot.requeuePrompt?.jobIds?.length || 0;

	return (
		<AutoPrintContext.Provider value={value}>
			{children}
			{requeueCount > 0 && (
				<ConfirmDialog
					title="Resume automated printing?"
					message={`Automated printing is on and ${requeueCount} unprinted ${requeueCount === 1 ? "job" : "jobs"} ${requeueCount === 1 ? "was" : "were"} left over. Start printing ${requeueCount === 1 ? "it" : "them"} now? Some documents may have printed just before the app closed — review first if unsure. Choosing “Not now” keeps ${requeueCount === 1 ? "it" : "them"} in the queue but pauses automated printing — press Resume in Print Jobs when you're ready.`}
					confirmLabel="Re-queue & print"
					cancelLabel="Not now (pause)"
					onConfirm={() => window.electronAPI.resolveRequeue(true)}
					onCancel={() => window.electronAPI.resolveRequeue(false)}
				/>
			)}
			{toasts.length > 0 && createPortal(
				<div className="toast-stack">
					{toasts.map((t) => (
						<div key={t.id} className="toast toast--error" role="alert">
							<span className="toast__msg">{t.message}</span>
							<button className="toast__close" onClick={() => dismissToast(t.id)} title="Dismiss">×</button>
						</div>
					))}
				</div>,
				document.body
			)}
		</AutoPrintContext.Provider>
	);
}

export function useAutoPrint() {
	const ctx = useContext(AutoPrintContext);
	if (!ctx) throw new Error("useAutoPrint must be used within an AutoPrintProvider");
	return ctx;
}
