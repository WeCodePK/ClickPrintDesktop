import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import ConfirmDialog from "./components/ConfirmDialog";

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
		case "pdf-cancel":
			return `Saving “${fileName}” as PDF was cancelled. To cancel the job, use the Decline Job button.`;
		case "fail-report-error":
			return "Couldn't mark the job as failed — please try again.";
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
