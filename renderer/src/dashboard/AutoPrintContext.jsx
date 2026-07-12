import { createContext, useContext, useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { ACTIVE_STATUSES } from "./jobUtils";
import { useJobs } from "./JobsContext";
import ConfirmDialog from "./components/ConfirmDialog";

// Owns all print execution (manual + automated) and the per-file print progress
// that both share. When Auto-Print is ON, every new job arriving via SSE is fed
// into a sequential FIFO queue and printed silently, file by file, with no
// operator interaction. Lives at the dashboard level so it keeps running across
// tab switches.

const PRINTED_STORAGE_KEY = "clickprint:printedFiles";

function loadPrintedFiles() {
	try {
		return JSON.parse(localStorage.getItem(PRINTED_STORAGE_KEY)) || {};
	} catch {
		return {};
	}
}

const AutoPrintContext = createContext(null);

export function AutoPrintProvider({ children }) {
	const { printJobs, setPrintJobs, jobsLoading } = useJobs();

	const [autoPrintEnabled, setEnabled] = useState(false);
	const [hydrated, setHydrated] = useState(false); // autoprint value loaded from store
	const [paused, setPaused] = useState(false);
	const [queueIds, setQueueIds] = useState([]); // FIFO of jobIds awaiting/printing
	const [current, setCurrent] = useState(null); // { jobId, fileId } printing right now
	const [printedFiles, setPrintedFiles] = useState(loadPrintedFiles); // { jobId: { fileId: true } }
	const [failedFiles, setFailedFiles] = useState({}); // ephemeral, per session
	const [busyJobs, setBusyJobs] = useState({}); // manual "print all" in flight
	const [requeuePrompt, setRequeuePrompt] = useState(null); // jobIds pending launch re-queue
	const [selectedPrinter, setSelectedPrinter] = useState(null); // validated saved default
	const [printersReady, setPrintersReady] = useState(false); // first printer check done

	const busyRef = useRef(false); // guards the auto processor against re-entrancy
	const seenRef = useRef(new Set()); // jobIds already considered for enqueue
	const initedRef = useRef(false); // launch handling done
	const firstCheckRef = useRef(true); // gates one-time auto-print hydration
	const [tick, setTick] = useState(0); // nudges the processor after async work

	// Live mirror of printJobs, so event listeners can read the current list
	// without being re-subscribed on every job update.
	const printJobsRef = useRef(printJobs);
	printJobsRef.current = printJobs;

	// Transient toast notifications (e.g. a job whose files failed to download).
	const [toasts, setToasts] = useState([]);
	const pushToast = useCallback((message) => {
		const id = Date.now() + Math.random();
		setToasts((t) => [...t, { id, message }]);
		setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
	}, []);
	const dismissToast = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);

	// ── printed-progress persistence + reconciliation ──────────────────────────
	useEffect(() => {
		try {
			localStorage.setItem(PRINTED_STORAGE_KEY, JSON.stringify(printedFiles));
		} catch (err) {
			console.warn("[AutoPrint] failed to persist print progress:", err.message);
		}
	}, [printedFiles]);

	useEffect(() => {
		if (printJobs.length === 0) return;
		const present = new Set(printJobs.map((j) => j._id));
		setPrintedFiles((prev) => {
			let changed = false;
			const next = {};
			for (const id of Object.keys(prev)) {
				if (present.has(id)) next[id] = prev[id];
				else changed = true;
			}
			return changed ? next : prev;
		});
	}, [printJobs]);

	// Keep the auto-print queue in sync with the live job list. A job that's no
	// longer active — a customer cancelled it from their app, or it completed /
	// failed — is dropped from the queue immediately so it never reaches the
	// printer. (The processor also drops queue[0] when it turns terminal; this
	// prunes jobs deeper in the queue too.)
	useEffect(() => {
		const activeIds = new Set(
			printJobs.filter((j) => ACTIVE_STATUSES.has(j.rawStatus)).map((j) => j._id)
		);
		setQueueIds((q) => {
			const next = q.filter((id) => activeIds.has(id));
			return next.length === q.length ? q : next;
		});
	}, [printJobs]);

	// ── printer validation + auto-print hydration ───────────────────────────────
	// Polls the live printer list and the saved default. If the selected printer
	// has gone (disconnected / offline), it is cleared and automated printing is
	// forced off — auto-print can't run without a real printer. Also the single
	// source of truth for the currently-selected printer across the dashboard.
	const checkPrinters = useCallback(async () => {
		try {
			const [list, saved, ap] = await Promise.all([
				window.electronAPI.listPrinters(),
				window.electronAPI.getSelectedPrinter(),
				window.electronAPI.getAutoPrint(),
			]);
			const online = list?.success ? list.data || [] : [];
			// Only treat the printer as gone when we have an authoritative list.
			const gone = list?.success && saved && !online.some((p) => p.name === saved.name);

			if (gone) {
				console.warn("[AutoPrint] selected printer offline — clearing:", saved.name);
				await window.electronAPI.setSelectedPrinter(null);
				await window.electronAPI.setAutoPrint(false);
				setSelectedPrinter(null);
				setEnabled(false);
				setPaused(false);
				setQueueIds([]); // nothing to auto-print without a printer
			} else {
				setSelectedPrinter(saved || null);
				// Hydrate the enabled flag from the store once; after that it's owned
				// by the toggle + gone-detection so polling can't clobber a toggle.
				if (firstCheckRef.current) setEnabled(!!ap);
			}
		} catch (err) {
			console.error("[AutoPrint] printer check failed:", err);
		} finally {
			firstCheckRef.current = false;
			setPrintersReady(true);
			setHydrated(true);
		}
	}, []);

	useEffect(() => {
		checkPrinters();
		const id = setInterval(checkPrinters, 15000);
		return () => clearInterval(id);
	}, [checkPrinters]);

	// ── shared print progress helpers ───────────────────────────────────────────
	const isFilePrinted = useCallback((jobId, fileId) => !!printedFiles[jobId]?.[fileId], [printedFiles]);

	const markFilePrinted = useCallback((jobId, fileId) => {
		setPrintedFiles((prev) => ({ ...prev, [jobId]: { ...(prev[jobId] || {}), [fileId]: true } }));
	}, []);

	const clearJobPrinted = useCallback((jobId) => {
		setPrintedFiles((prev) => {
			if (!prev[jobId]) return prev;
			const next = { ...prev };
			delete next[jobId];
			return next;
		});
	}, []);

	// A job's cached files are only ever read while it's active (previews, print).
	// Once it reaches a terminal state (completed/cancelled) they're never touched
	// again — History shows metadata only — so delete them from disk to avoid
	// piling up in userData indefinitely. Best-effort: logged, never surfaced.
	const cleanupJobFiles = useCallback(async (job) => {
		clearJobPrinted(job._id);
		const fileIds = (job.files || []).map((f) => f.fileId).filter(Boolean);
		if (fileIds.length === 0) return;
		try {
			const result = await window.electronAPI.deleteJobFiles(fileIds);
			if (!result?.success) throw new Error(result?.message || "delete failed");
		} catch (err) {
			console.error("[AutoPrint] failed to delete job files:", err);
		}
	}, [clearJobPrinted]);

	const setJobStatus = useCallback((jobId, status, rawStatus) => {
		setPrintJobs((prev) => prev.map((j) => (j._id === jobId ? { ...j, status, rawStatus } : j)));
	}, [setPrintJobs]);

	// A job whose file download failed (even after retry) is marked "failed" on the
	// backend by the main process. React here: drop it from the queue and mark it
	// failed locally so it leaves the active list immediately (the next reconcile
	// confirms it). Its cached files were already deleted in the main process.
	useEffect(() => {
		if (!window.electronAPI.onJobFailed) return;
		return window.electronAPI.onJobFailed((jobId) => {
			console.warn("[AutoPrint] job download failed — removing:", jobId);
			const job = printJobsRef.current.find((j) => j._id === jobId);
			const who = job?.createdBy?.name || job?.createdBy?.number || `#${String(jobId).slice(-6)}`;
			pushToast(`Job (${who}) failed — files couldn’t be downloaded.`);
			setQueueIds((q) => q.filter((id) => id !== jobId));
			setFailedFiles((prev) => {
				if (!prev[jobId]) return prev;
				const next = { ...prev };
				delete next[jobId];
				return next;
			});
			clearJobPrinted(jobId);
			setJobStatus(jobId, "completed", "failed");
		});
	}, [clearJobPrinted, setJobStatus, pushToast]);

	// ── print primitives (used by both manual and auto paths) ───────────────────
	const ensurePrintingStatus = useCallback(async (job) => {
		if (job.rawStatus === "printing") return;
		setJobStatus(job._id, "processing", "printing");
		try {
			const result = await window.electronAPI.updateJobStatus(job._id, "printing");
			if (!result?.success) throw new Error(result?.message || "request failed");
		} catch (err) {
			console.error("[AutoPrint] failed to set job printing:", err);
		}
	}, [setJobStatus]);

	const completeJob = useCallback(async (job) => {
		setJobStatus(job._id, "completed", "completed");
		try {
			const result = await window.electronAPI.updateJobStatus(job._id, "completed");
			if (!result?.success) throw new Error(result?.message || "request failed");
			await cleanupJobFiles(job);
		} catch (err) {
			console.error("[AutoPrint] failed to complete job:", err);
			setJobStatus(job._id, job.status, job.rawStatus); // revert
		}
	}, [setJobStatus, cleanupJobFiles]);

	const printOneFile = useCallback(async (jobId, file, deviceName) => {
		setCurrent({ jobId, fileId: file.fileId });
		try {
			const result = await window.electronAPI.printFile(file.fileId, file.settings, deviceName);
			if (!result?.success) throw new Error(result?.message || "print failed");
			return true;
		} catch (err) {
			console.error("[AutoPrint] failed to print file:", err);
			return false;
		} finally {
			setCurrent(null);
		}
	}, []);

	// ── manual actions (used by the Print Jobs buttons when auto-print is OFF) ───
	const printFileManual = useCallback(async (job, file, deviceName) => {
		if (!job || isFilePrinted(job._id, file.fileId) || busyJobs[job._id]) return;
		await ensurePrintingStatus(job);
		const ok = await printOneFile(job._id, file, deviceName);
		if (!ok) return;
		markFilePrinted(job._id, file.fileId);
		const printedForJob = { ...(printedFiles[job._id] || {}), [file.fileId]: true };
		const files = job.files || [];
		if (files.length && files.every((f) => printedForJob[f.fileId])) await completeJob(job);
	}, [isFilePrinted, busyJobs, ensurePrintingStatus, printOneFile, markFilePrinted, printedFiles, completeJob]);

	const printAllManual = useCallback(async (job, deviceName) => {
		if (!job || busyJobs[job._id]) return;
		setBusyJobs((prev) => ({ ...prev, [job._id]: true }));
		await ensurePrintingStatus(job);
		const files = job.files || [];
		const printedForJob = { ...(printedFiles[job._id] || {}) };
		for (const file of files) {
			if (printedForJob[file.fileId]) continue;
			const ok = await printOneFile(job._id, file, deviceName);
			if (ok) {
				printedForJob[file.fileId] = true;
				markFilePrinted(job._id, file.fileId);
			}
		}
		setBusyJobs((prev) => ({ ...prev, [job._id]: false }));
		if (files.length && files.every((f) => printedForJob[f.fileId])) await completeJob(job);
	}, [busyJobs, ensurePrintingStatus, printedFiles, printOneFile, markFilePrinted, completeJob]);

	// ── enqueue helpers ─────────────────────────────────────────────────────────
	const enqueue = useCallback((ids) => {
		setQueueIds((prev) => [...prev, ...ids.filter((id) => !prev.includes(id))]);
	}, []);

	// Launch handling (edge case 2): once jobs have loaded, prompt to re-queue any
	// unprinted active jobs if auto-print was left on.
	useEffect(() => {
		if (!hydrated || jobsLoading || initedRef.current) return;
		initedRef.current = true;
		const active = printJobs.filter((j) => ACTIVE_STATUSES.has(j.rawStatus));
		active.forEach((j) => seenRef.current.add(j._id));
		if (autoPrintEnabled) {
			const candidates = active
				.filter((j) => (j.files || []).some((f) => !isFilePrinted(j._id, f.fileId)))
				.map((j) => j._id);
			if (candidates.length) setRequeuePrompt(candidates);
		}
	}, [hydrated, jobsLoading, printJobs, autoPrintEnabled, isFilePrinted]);

	// Auto-enqueue jobs that arrive after launch while enabled.
	useEffect(() => {
		if (!initedRef.current || !autoPrintEnabled) return;
		const active = printJobs.filter((j) => ACTIVE_STATUSES.has(j.rawStatus));
		const fresh = active.filter((j) => !seenRef.current.has(j._id));
		if (fresh.length === 0) return;
		fresh.forEach((j) => seenRef.current.add(j._id));
		enqueue(fresh.map((j) => j._id));
	}, [printJobs, autoPrintEnabled, enqueue]);

	// ── the FIFO auto processor ──────────────────────────────────────────────────
	// Prints one file per pass, checking `paused` between files so a pause lets the
	// in-flight document finish but halts before the next. Drains even when
	// disabled (so toggling off lets the queue finish — edge case 1).
	useEffect(() => {
		if (paused || busyRef.current || queueIds.length === 0) return;

		const jobId = queueIds[0];
		const job = printJobs.find((j) => j._id === jobId);
		if (!job || !ACTIVE_STATUSES.has(job.rawStatus)) {
			setQueueIds((q) => q.filter((id) => id !== jobId)); // gone/terminal → drop
			return;
		}

		const files = job.files || [];
		const jobFailed = failedFiles[jobId] || {};
		const nextFile = files.find((f) => !isFilePrinted(jobId, f.fileId) && !jobFailed[f.fileId]);

		busyRef.current = true;
		(async () => {
			if (!nextFile) {
				// Nothing left to print for this job.
				const allPrinted = files.length > 0 && files.every((f) => isFilePrinted(jobId, f.fileId));
				if (allPrinted) await completeJob(job);
				setQueueIds((q) => q.filter((id) => id !== jobId));
			} else {
				await ensurePrintingStatus(job);
				const ok = await printOneFile(jobId, nextFile);
				if (ok) markFilePrinted(jobId, nextFile.fileId);
				else setFailedFiles((prev) => ({ ...prev, [jobId]: { ...(prev[jobId] || {}), [nextFile.fileId]: true } }));
			}
			busyRef.current = false;
			setTick((t) => t + 1);
		})();
	}, [queueIds, paused, printedFiles, printJobs, failedFiles, tick, isFilePrinted, ensurePrintingStatus, printOneFile, markFilePrinted, completeJob]);

	// ── toggle + pause API ───────────────────────────────────────────────────────
	const enableAutoPrint = useCallback(async () => {
		await window.electronAPI.setAutoPrint(true);
		setEnabled(true);
		// Enqueue the current backlog immediately (chosen behavior).
		const active = printJobs.filter((j) => ACTIVE_STATUSES.has(j.rawStatus));
		active.forEach((j) => seenRef.current.add(j._id));
		enqueue(active.filter((j) => (j.files || []).some((f) => !isFilePrinted(j._id, f.fileId))).map((j) => j._id));
	}, [printJobs, isFilePrinted, enqueue]);

	const disableAutoPrint = useCallback(async () => {
		await window.electronAPI.setAutoPrint(false);
		setEnabled(false); // existing queue keeps draining; new jobs won't enqueue
		setPaused(false); // ensure the queue actually drains (edge case 1)
	}, []);

	// "Re-queue & print now" — enqueue the leftovers and let them run.
	const confirmRequeue = useCallback(() => {
		if (requeuePrompt) enqueue(requeuePrompt);
		setRequeuePrompt(null);
	}, [requeuePrompt, enqueue]);

	// "Not now" — still enqueue the leftovers, but start the queue paused so the
	// operator can review/decline before anything prints. Resume kicks it off.
	const dismissRequeue = useCallback(() => {
		if (requeuePrompt) enqueue(requeuePrompt);
		setPaused(true);
		setRequeuePrompt(null);
	}, [requeuePrompt, enqueue]);

	// State line for a job in the queue (for the list UI).
	const queueInfoFor = useCallback((jobId) => {
		const idx = queueIds.indexOf(jobId);
		if (idx === -1) return null;
		if (idx === 0) return { state: paused ? "paused" : "printing", place: 0 };
		return { state: "queued", place: idx };
	}, [queueIds, paused]);

	const value = {
		autoPrintEnabled,
		paused,
		setPaused,
		queueIds,
		queueCount: queueIds.length,
		current,
		printedFiles,
		isFilePrinted,
		busyJobs,
		enableAutoPrint,
		disableAutoPrint,
		printFileManual,
		printAllManual,
		clearJobPrinted,
		cleanupJobFiles,
		queueInfoFor,
		selectedPrinter,
		printersReady,
		refreshPrinterState: checkPrinters,
	};

	return (
		<AutoPrintContext.Provider value={value}>
			{children}
			{requeuePrompt && (
				<ConfirmDialog
					title="Resume automated printing?"
					message={`Automated printing is on and ${requeuePrompt.length} unprinted ${requeuePrompt.length === 1 ? "job" : "jobs"} ${requeuePrompt.length === 1 ? "was" : "were"} left over. Start printing ${requeuePrompt.length === 1 ? "it" : "them"} now? Choosing “Not now” keeps ${requeuePrompt.length === 1 ? "it" : "them"} in the queue but pauses automated printing — press Resume in Print Jobs when you’re ready.`}
					confirmLabel="Re-queue & print"
					cancelLabel="Not now (pause)"
					onConfirm={confirmRequeue}
					onCancel={dismissRequeue}
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
