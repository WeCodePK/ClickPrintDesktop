import { useState, useEffect, useCallback } from "react";
import { useJobs } from "../JobsContext";
import { useAutoPrint } from "../AutoPrintContext";
import { ACTIVE_STATUSES, getJobPrintMode } from "../jobUtils";
import ListColumn from "../components/ListColumn";
import WelcomePane from "../components/WelcomePane";
import JobDetailCard from "../components/JobDetailCard";
import ConfirmDialog from "../components/ConfirmDialog";
import PrintSplitButton from "../components/PrintSplitButton";
import { CheckIcon, TrashIcon, SearchIcon, PrinterIcon, PauseIcon, PlayIcon } from "../icons";

// Statuses from which the backend won't allow a direct jump to "completed" — the
// job must pass through "printing" first. Marking one of these complete needs the
// step-through path (see handleForceComplete).
const PRE_PRINT_STATUSES = new Set(["draft", "submitted", "queued"]);

// Print Jobs tab: active job queue on the left, job details on the right. Print
// execution + progress live in AutoPrintContext (shared with the auto queue);
// this tab renders the UI and drives the manual actions.
function PrintJobsTab() {
	const { printJobs, setPrintJobs, jobsLoading } = useJobs();
	const {
		autoPrintEnabled,
		paused,
		setPaused,
		queueCount,
		queueInfoFor,
		current,
		isFilePrinted,
		printedFiles,
		failedFiles,
		failJob,
		busyJobs,
		printFileManual,
		printAllManual,
		cleanupJobFiles,
		selectedPrinter: defaultPrinter,
		refreshPrinterState,
	} = useAutoPrint();

	const [selectedId, setSelectedId] = useState(null);
	const [pendingCancel, setPendingCancel] = useState(null);
	const [pendingComplete, setPendingComplete] = useState(null);
	const [query, setQuery] = useState("");

	// Available printers for the manual print dropdowns; the saved default comes
	// from AutoPrintContext (selectedPrinter), the single source of truth kept in
	// sync with the Printers tab and the 15s reachability poll.
	const [printers, setPrinters] = useState([]);

	const refreshPrinters = useCallback(async (force = false) => {
		try {
			const list = await window.electronAPI.listPrinters(force);
			if (list?.success) setPrinters(list.data || []);
			refreshPrinterState();
		} catch (err) {
			console.error("[Renderer] failed to load printers:", err);
		}
	}, [refreshPrinterState]);

	useEffect(() => {
		refreshPrinters();
	}, [refreshPrinters]);

	// Oldest job first (queue order). formattedNumber is a display-friendly phone.
	const entries = printJobs
		.filter((j) => ACTIVE_STATUSES.has(j.rawStatus))
		.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
		.map((job) => {
			const n = job.createdBy?.number || "";
			const sn = n.startsWith("0") ? n.slice(1) : n;
			const formattedNumber = "0".concat(sn.slice(2));
			return { ...job, formattedNumber };
		});

	const q = query.trim().toLowerCase();
	const visible = q
		? entries.filter((e) =>
				`${e.formattedNumber || ""} ${e.createdBy?.name || ""}`.toLowerCase().includes(q)
			)
		: entries;

	// Derive the selected job from the live list so background status/progress
	// changes (e.g. the auto queue) are reflected in the detail pane immediately.
	const selectedEntry = entries.find((e) => e._id === selectedId) || null;

	// Optimistic status change on the shared job list. Returns a revert function.
	const applyStatus = (jobId, status, rawStatus) => {
		const prevJob = printJobs.find((j) => j._id === jobId);
		setPrintJobs((prev) => prev.map((j) => (j._id === jobId ? { ...j, status, rawStatus } : j)));
		return () => {
			if (!prevJob) return;
			setPrintJobs((prev) =>
				prev.map((j) => (j._id === jobId ? { ...j, status: prevJob.status, rawStatus: prevJob.rawStatus } : j))
			);
		};
	};

	const handleConfirmCancel = async () => {
		const job = pendingCancel;
		if (!job) return;
		setPendingCancel(null);
		setSelectedId(null);
		const revert = applyStatus(job._id, "completed", "cancelled");
		try {
			const result = await window.electronAPI.updateJobStatus(job._id, "cancelled");
			if (!result?.success) throw new Error(result?.message || "request failed");
			await cleanupJobFiles(job);
		} catch (err) {
			console.error("[Renderer] failed to cancel job:", err);
			revert();
		}
	};

	const handleConfirmComplete = async () => {
		const job = pendingComplete;
		if (!job) return;
		setPendingComplete(null);
		setSelectedId(null);
		const revert = applyStatus(job._id, "completed", "completed");
		try {
			const result = await window.electronAPI.updateJobStatus(job._id, "completed");
			if (!result?.success) throw new Error(result?.message || "request failed");
			await cleanupJobFiles(job);
		} catch (err) {
			console.error("[Renderer] failed to mark job complete:", err);
			revert();
		}
	};

	// Completes a never-printed (queued) job. The backend requires
	// queued → printing → completed, so we step through "printing". The UI jumps
	// straight to completed (optimistically) so the intermediate state never shows.
	const handleForceComplete = async () => {
		const job = pendingComplete;
		if (!job) return;
		setPendingComplete(null);
		setSelectedId(null);
		const revert = applyStatus(job._id, "completed", "completed");
		try {
			const printing = await window.electronAPI.updateJobStatus(job._id, "printing");
			if (!printing?.success) throw new Error(printing?.message || "printing transition failed");
			const result = await window.electronAPI.updateJobStatus(job._id, "completed");
			if (!result?.success) throw new Error(result?.message || "request failed");
			await cleanupJobFiles(job);
		} catch (err) {
			console.error("[Renderer] failed to force-complete job:", err);
			revert();
		}
	};

	const handlePreviewFile = async (file) => {
		try {
			const result = await window.electronAPI.openFile(file.fileId);
			if (!result?.success) throw new Error(result?.message || "open failed");
		} catch (err) {
			console.error("[Renderer] failed to preview file:", err);
		}
	};

	// Manual print handlers delegate to the shared context (used only when
	// auto-print is off — the buttons are disabled when it's on).
	const handlePrintFile = (file, deviceName) => printFileManual(selectedEntry, file, deviceName);
	const handlePrintAll = (deviceName) => printAllManual(selectedEntry, deviceName);

	// Human label for a job's queue position.
	const queueLine = (jobId) => {
		const info = queueInfoFor(jobId);
		if (!info) return null;
		if (info.state === "printing") {
			return (
				<span className="db-entry__queue db-entry__queue--printing">
					<span className="db-entry__queue-dot" />
					Printing now
				</span>
			);
		}
		if (info.state === "paused") {
			return <span className="db-entry__queue db-entry__queue--paused">Paused (next up)</span>;
		}
		return <span className="db-entry__queue">In queue · Nº{info.place}</span>;
	};

	return (
		<>
			<ListColumn title="Print Jobs" count={visible.length}>
				<div className="db-search">
					<SearchIcon />
					<input
						className="db-search__input"
						type="text"
						placeholder="Search any print job…"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
					/>
					{query && (
						<button className="db-search__clear" onClick={() => setQuery("")} title="Clear">
							×
						</button>
					)}
				</div>

				{autoPrintEnabled && (
					<div className="queue-bar">
						<span className="queue-bar__status">
							{paused
								? "Queue paused"
								: queueCount > 0
									? `Auto-printing · ${queueCount} in queue`
									: "Auto-print on · idle"}
						</span>
						<button className="queue-bar__btn" onClick={() => setPaused((p) => !p)}>
							{paused ? (
								<>
									<PlayIcon />
									Resume
								</>
							) : (
								<>
									<PauseIcon />
									Pause
								</>
							)}
						</button>
					</div>
				)}

				{jobsLoading ? (
					<div className="db-coming-soon">
						<div className="spinner spinner--dark" />
						<p>Loading jobs…</p>
					</div>
				) : visible.length === 0 ? (
					<div className="db-coming-soon">
						<p>{q ? "No jobs match that number" : "No active print jobs"}</p>
					</div>
				) : (
					visible.map((entry) => {
						const queueIndex = entries.indexOf(entry);
						return (
							<button
								key={entry._id}
								className={`db-entry db-entry--job ${selectedId === entry._id ? "db-entry--top" : ""}`}
								onClick={() => setSelectedId(entry._id)}
							>
								<span className="db-entry__qnum">{queueIndex + 1}</span>
								<div className="db-entry__info">
									<div className="db-entry__line">
										<span className="db-entry__name">{entry.formattedNumber || "Unknown number"}</span>
										<span className="db-entry__price">Rs. {entry.price}</span>
									</div>
									<div className="db-entry__line">
										<span className="db-entry__sub">
											{entry.createdBy?.name ? `${entry.createdBy.name} · ` : ""}
											{entry.copies} {entry.copies === 1 ? "copy" : "copies"} · {getJobPrintMode(entry, true)} · {entry.filesCount} {entry.filesCount === 1 ? "file" : "files"}
										</span>
										<span className="db-entry__right">
											<span className="db-entry__time">{entry.time}</span>
											<span className={`db-entry__dot db-entry__dot--${entry.status}`} />
										</span>
									</div>
									{autoPrintEnabled && queueLine(entry._id)}
								</div>
							</button>
						);
					})
				)}
			</ListColumn>

			<div className="db-detail">
				{selectedEntry ? (() => {
					const jobPrinted = printedFiles[selectedEntry._id] || {};
					const jobFailed = failedFiles[selectedEntry._id] || {};
					const isPrintingAll = !!busyJobs[selectedEntry._id];
					const isThisJobPrinting = current?.jobId === selectedEntry._id;
					const currentFileId = isThisJobPrinting ? current.fileId : null;
					const remainingCount = (selectedEntry.files || []).filter((f) => !jobPrinted[f.fileId]).length;
					const actionsLocked = isPrintingAll || isThisJobPrinting;

					return (
						<JobDetailCard
							entry={selectedEntry}
							onPreviewFile={handlePreviewFile}
							onPrintFile={handlePrintFile}
							printedFileIds={jobPrinted}
							failedFileIds={jobFailed}
							onMarkJobFailed={() => failJob(selectedEntry)}
							printingAll={isPrintingAll}
							printers={printers}
							selectedPrinterName={defaultPrinter?.name}
							onPrinterMenuOpen={() => refreshPrinters(true)}
							autoPrintOn={autoPrintEnabled}
							currentFileId={currentFileId}
							headerActions={
								selectedEntry.status !== "completed" ? (
									<>
										<button
											className="btn-outline btn-outline-danger"
											onClick={() => setPendingCancel(selectedEntry)}
											disabled={actionsLocked}
										>
											<TrashIcon />
											Decline Job
										</button>
										<button
											className="btn-outline"
											onClick={() => setPendingComplete(selectedEntry)}
											disabled={actionsLocked}
										>
											<CheckIcon />
											Mark as Complete
										</button>
										{autoPrintEnabled ? (
											<span className="autoprint-tip" title="Automated printing is on — printing is handled automatically">
												<button className="btn-gradient" disabled style={{ pointerEvents: "none" }}>
													<PrinterIcon />
													Auto-printing
												</button>
											</span>
										) : (
											<PrintSplitButton
												size="md"
												onPrint={handlePrintAll}
												onOpen={() => refreshPrinters(true)}
												printers={printers}
												selectedName={defaultPrinter?.name}
												busy={isPrintingAll}
												disabled={remainingCount === 0}
												showInfo
												label={
													<>
														<PrinterIcon />
														Print ({remainingCount} {remainingCount === 1 ? "doc" : "docs"})
													</>
												}
											/>
										)}
									</>
								) : null
							}
						/>
					);
				})() : (
					<WelcomePane />
				)}
			</div>

			{pendingCancel && (
				<ConfirmDialog
					title="Decline this job?"
					message={`Are you sure you want to cancel "${pendingCancel.fileName}"? This will notify the customer and cannot be undone.`}
					confirmLabel="Yes, decline"
					cancelLabel="Keep job"
					danger
					onConfirm={handleConfirmCancel}
					onCancel={() => setPendingCancel(null)}
				/>
			)}

			{pendingComplete && (
				PRE_PRINT_STATUSES.has(pendingComplete.rawStatus) ? (
					<div className="modal-overlay" onClick={() => setPendingComplete(null)}>
						<div className="modal-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
							<h3 className="modal-title">Print before completing</h3>
							<p className="modal-message">
								“{pendingComplete.fileName}” hasn’t been printed yet, so it can’t be marked complete.
								Print it first, then mark it complete.
							</p>
							<div className="modal-actions">
								<button className="btn-gradient" onClick={() => setPendingComplete(null)}>Got it</button>
							</div>
							<button type="button" className="modal-subtle" onClick={handleForceComplete}>
								Mark complete without printing
							</button>
						</div>
					</div>
				) : (
					<ConfirmDialog
						title="Mark this job as complete?"
						message={`Are you sure "${pendingComplete.fileName}" is done? This action can't be undone, and the customer will be notified that their print is ready.`}
						confirmLabel="Yes, mark complete"
						cancelLabel="Not yet"
						onConfirm={handleConfirmComplete}
						onCancel={() => setPendingComplete(null)}
					/>
				)
			)}
		</>
	);
}

export default PrintJobsTab;
