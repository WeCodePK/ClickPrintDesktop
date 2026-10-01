import { useState, useEffect, useCallback } from "react";
import { useJobs } from "../JobsContext";
import { useAutoPrint } from "../AutoPrintContext";
import { ACTIVE_STATUSES, jobLabel, applySettingsOverrides, formatPhone } from "../jobUtils";
import ListColumn from "../components/ListColumn";
import WelcomePane from "../components/WelcomePane";
import JobDetailCard from "../components/JobDetailCard";
import JobListCard from "../components/JobListCard";
import RefreshButton from "../components/RefreshButton";
import EmptyState from "../components/EmptyState";
import ConfirmDialog from "../components/ConfirmDialog";
import PrintSplitButton from "../components/PrintSplitButton";
import { CheckIcon, CrossIcon, SearchIcon, PrinterIcon, PauseIcon, PlayIcon, FolderIcon, ChevronDownIcon } from "../icons";

// Statuses from which the backend won't allow a direct jump to "completed" — the
// job must pass through "printing" first. The main-process engine performs the
// step-through when asked to force-complete.
const PRE_PRINT_STATUSES = new Set(["draft", "submitted", "queued"]);

const MANUAL_COLLAPSED_KEY = "clickprint:manualPaneCollapsed";

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// Print Jobs tab: active job queue on the left, job details on the right. All
// print execution/orchestration lives in the main-process engine (mirrored via
// AutoPrintContext); this tab renders the UI and sends commands.
function PrintJobsTab() {
	const { printJobs, jobsLoading, refreshJobs } = useJobs();
	const {
		autoPrintEnabled,
		queueInfoFor,
		printedFiles,
		fileStates,
		jobPrintingNow,
		failJob,
		declineJob,
		completeJob,
		printFileManual,
		printAllManual,
		stopPrintJob,
		jobHasQueuedDocs,
		jobHasQueuedManualDocs,
		jobAutoPaused,
		jobNeedsAttention,
		jobAutoActive,
		jobManualOnly,
		setJobAutoPaused,
		refreshPrinterState,
		settingsOverrides,
		setFileSettings,
		updateHold,
	} = useAutoPrint();

	const [selectedId, setSelectedId] = useState(null);
	// Whether the Manual intervention pane is folded down to its header. A
	// per-operator convenience, remembered on this machine.
	const [manualCollapsed, setManualCollapsed] = useState(() => {
		try {
			return localStorage.getItem(MANUAL_COLLAPSED_KEY) === "1";
		} catch {
			return false;
		}
	});
	const toggleManualCollapsed = () =>
		setManualCollapsed((collapsed) => {
			try {
				localStorage.setItem(MANUAL_COLLAPSED_KEY, collapsed ? "0" : "1");
			} catch {
				// Storage unavailable — the toggle still works for this session.
			}
			return !collapsed;
		});
	const [pendingCancel, setPendingCancel] = useState(null);
	const [pendingComplete, setPendingComplete] = useState(null);
	// Set when a cancel was refused because the job is already printing — the
	// backend can't cancel from there, so we explain it and offer the refund.
	const [declineBlocked, setDeclineBlocked] = useState(null);
	const [query, setQuery] = useState("");

	// Available printers for the manual print dropdowns. Printing without an
	// explicit pick routes each document to its service's automated printer
	// (resolved in AutoPrintContext) — there is no app-wide default printer.
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
	// The operator's setting overrides are applied here, so the list rows and the
	// detail card both show what will actually print.
	const entries = printJobs
		.filter((j) => ACTIVE_STATUSES.has(j.rawStatus))
		.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
		.map((job) =>
			applySettingsOverrides({ ...job, formattedNumber: formatPhone(job.createdBy?.number) || "" }, settingsOverrides[job._id])
		);

	const q = query.trim().toLowerCase();
	const visible = q
		? entries.filter((e) =>
				`${e.code || ""} #${e.code || ""} ${e.formattedNumber || ""} ${e.createdBy?.name || ""}`.toLowerCase().includes(q)
			)
		: entries;

	// Derive the selected job from the live list so background status/progress
	// changes (e.g. the auto queue) are reflected in the detail pane immediately.
	const selectedEntry = entries.find((e) => e._id === selectedId) || null;

	// Job actions are commands to the main-process engine; the engine applies the
	// status change to its authoritative job list and re-pushes it, so no
	// renderer-side optimism is needed.
	const handleConfirmCancel = async () => {
		const job = pendingCancel;
		if (!job) return;
		setPendingCancel(null);
		const result = await declineJob(job._id);
		if (result?.success) {
			setSelectedId(null);
			return;
		}
		// Already printing: the backend won't cancel from there. Keep the job
		// selected and explain, offering the refund as a separate, deliberate step.
		if (result?.reason === "already-printing") {
			setDeclineBlocked(job);
			return;
		}
		console.error("[Renderer] failed to cancel job:", result?.message);
	};

	// The escape hatch from that dialog: fail the job, which refunds the customer.
	const handleFailInstead = async () => {
		const job = declineBlocked;
		if (!job) return;
		setDeclineBlocked(null);
		setSelectedId(null);
		const result = await failJob(job);
		if (!result?.success) console.error("[Renderer] failed to mark job failed:", result?.message);
	};

	const handleConfirmComplete = async () => {
		const job = pendingComplete;
		if (!job) return;
		setPendingComplete(null);
		setSelectedId(null);
		const result = await completeJob(job._id);
		if (!result?.success) console.error("[Renderer] failed to mark job complete:", result?.message);
	};

	// Completes a never-printed (queued) job — the engine steps it through the
	// backend's required queued → printing → completed sequence.
	const handleForceComplete = async () => {
		const job = pendingComplete;
		if (!job) return;
		setPendingComplete(null);
		setSelectedId(null);
		const result = await completeJob(job._id, { force: true });
		if (!result?.success) console.error("[Renderer] failed to force-complete job:", result?.message);
	};

	// Opens a document's PDF, or with { raw: true } the customer's original upload.
	const handleOpenFile = async (file, opts) => {
		try {
			const result = await window.electronAPI.openFile(file.fileId, opts);
			if (!result?.success) throw new Error(result?.message || "open failed");
		} catch (err) {
			console.error("[Renderer] failed to open file:", err);
		}
	};

	const handleViewFiles = async (jobId) => {
		try {
			const result = await window.electronAPI.openJobFolder(jobId);
			if (!result?.success) throw new Error(result?.message || "open failed");
		} catch (err) {
			console.error("[Renderer] failed to open job folder:", err);
		}
	};

	// Manual print handlers delegate to the shared context (used only when
	// auto-print is off — the buttons are disabled when it's on).
	const handlePrintFile = (file, deviceName) => printFileManual(selectedEntry, file, deviceName);
	const handlePrintAll = () => printAllManual(selectedEntry);

	// Human label for a job's queue position — or, for a job automated printing
	// never takes, what the operator has to do before printing it by hand.
	const queueLine = (jobId) => {
		const info = autoPrintEnabled ? queueInfoFor(jobId) : null;
		if (!info) {
			const reasons = jobManualOnly(jobId);
			if (!reasons) return null;
			// A payment proof (alone or with comments) is the thing to act on first.
			const why = reasons.includes("payment-proof") ? "Verify payment" : "Check comments";
			return (
				<span
					className="db-entry__queue db-entry__queue--manual"
					title="Automated printing skips jobs with additional comments or a payment proof. Review it, then print it manually."
				>
					{why}
				</span>
			);
		}
		if (info.state === "printing") {
			return (
				<span className="db-entry__queue db-entry__queue--printing">
					<span className="db-entry__queue-dot" />
					Printing now
				</span>
			);
		}
		if (info.state === "attention") {
			return <span className="db-entry__queue db-entry__queue--attention">Needs attention</span>;
		}
		if (info.state === "paused") {
			return <span className="db-entry__queue db-entry__queue--paused">Paused</span>;
		}
		if (info.state === "waiting") {
			return <span className="db-entry__queue db-entry__queue--paused">Waiting for printer…</span>;
		}
		return <span className="db-entry__queue">In queue · Nº{info.place}</span>;
	};

	const renderEntry = (entry) => (
		<JobListCard
			key={entry._id}
			entry={entry}
			position={entries.indexOf(entry) + 1}
			selected={selectedId === entry._id}
			attention={jobNeedsAttention(entry._id)}
			footer={queueLine(entry._id)}
			onClick={() => setSelectedId(entry._id)}
		/>
	);

	// Top half: the print queue, led by jobs the engine parked after a failed
	// document (they need a human). Bottom half: jobs automated printing never
	// takes (comments / payment proof) — split out whether or not it's on, so the
	// list doesn't reshuffle when it's toggled.
	const attentionJobs = visible.filter((e) => jobNeedsAttention(e._id));
	const manualJobs = visible.filter((e) => !jobNeedsAttention(e._id) && jobManualOnly(e._id));
	const queueJobs = visible.filter((e) => !jobNeedsAttention(e._id) && !jobManualOnly(e._id));

	const sectionHeader = (title, count, variant) => (
		<div className={`db-list__section db-list__section--${variant}`}>
			<span className="db-list__section-title">{title}</span>
			<span className="db-list__section-count">{count}</span>
		</div>
	);

	return (
		<>
			<ListColumn
				title="Jobs"
				count={visible.length}
				action={<RefreshButton onRefresh={refreshJobs} label="Refresh jobs" />}
				className="db-list--jobs"
				bodyClassName="db-list__entries--split"
			>
				<div className="jobs-list__controls">
					<div className="db-search">
						<SearchIcon />
						<input
							className="db-search__input"
							type="text"
							placeholder="Search by code, name or number"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
						/>
						{query && (
							<button className="db-search__clear" onClick={() => setQuery("")} title="Clear">
								×
							</button>
						)}
					</div>
				</div>

				{jobsLoading ? (
					<div className="db-coming-soon">
						<div className="spinner spinner--dark" />
						<p>Loading jobs…</p>
					</div>
				) : (
					<>
						<div className="jobs-pane">
							<div className="jobs-pane__scroll">
								{attentionJobs.length + queueJobs.length === 0 ? (
									q ? (
										<EmptyState art="search" title="No matching jobs" />
									) : (
										<EmptyState art="tray" title="No jobs in the queue" />
									)
								) : (
									<>
										{attentionJobs.length > 0 && sectionHeader("Needs attention", attentionJobs.length, "attention")}
										{attentionJobs.map(renderEntry)}
										{queueJobs.map(renderEntry)}
									</>
								)}
							</div>
						</div>

						{/* Manual intervention folds away like a VS Code pane: its header always
						    stays, docked at the bottom when folded, and the queue above takes the
						    freed height (so an empty section needn't cost the queue any room). */}
						<div className={`jobs-pane jobs-pane--manual ${manualCollapsed ? "jobs-pane--collapsed" : ""}`}>
							<button
								type="button"
								className="db-list__section db-list__section--manual db-list__section--toggle"
								onClick={toggleManualCollapsed}
								aria-expanded={!manualCollapsed}
								title={manualCollapsed ? "Show manual intervention" : "Hide manual intervention"}
							>
								<span className="db-list__section-chevron">
									<ChevronDownIcon />
								</span>
								<span className="db-list__section-title">Manual intervention</span>
								<span className="db-list__section-count">{manualJobs.length}</span>
							</button>
							{!manualCollapsed && (
								<div className="jobs-pane__scroll">
									{manualJobs.length === 0 ? (
										q ? (
											<EmptyState art="search" title="No matching jobs" />
										) : (
											<EmptyState art="all-clear" title="No jobs need manual intervention" />
										)
									) : (
										manualJobs.map(renderEntry)
									)}
								</div>
							)}
						</div>
					</>
				)}
			</ListColumn>

			<div className="db-detail">
				{selectedEntry ? (() => {
					const jobPrinted = printedFiles[selectedEntry._id] || {};
					const jobStates = fileStates[selectedEntry._id] || {};
					const remainingCount = (selectedEntry.files || []).filter((f) => !jobPrinted[f.docId]).length;
					// Destructive actions stay available while documents merely wait in
					// the queue (declining drops them) — only an in-flight print locks them.
					const actionsLocked = jobPrintingNow(selectedEntry._id);
					// Docs still queued → the header control renders as Stop; anything
					// queued OR at a printer → the helper line reads "Printing…".
					const hasQueued = jobHasQueuedDocs(selectedEntry._id);
					// Automated printing drives this job only while it isn't paused for
					// it. Paused (by the operator, or by the engine after a failure) →
					// the manual controls come back so the operator can intervene.
					const autoDriving = jobAutoActive(selectedEntry._id);
					const autoHeld = autoPrintEnabled && jobAutoPaused(selectedEntry._id);
					const needsAttention = jobNeedsAttention(selectedEntry._id);

					return (
						<JobDetailCard
							entry={selectedEntry}
							onOpenFile={handleOpenFile}
							onChangeFileSettings={(file, patch) => setFileSettings(selectedEntry._id, file.docId, patch)}
							onPrintFile={handlePrintFile}
							printedFileIds={jobPrinted}
							fileStates={jobStates}
							onMarkJobFailed={() => failJob(selectedEntry)}
							printers={printers}
							onPrinterMenuOpen={() => refreshPrinters(true)}
							autoPrintOn={autoDriving}
							printLocked={updateHold}
							headerActions={
								selectedEntry.status !== "completed" ? (
									<>
										{/* The two ways to close a job, joined into one control. */}
										<div className="btn-segmented" role="group" aria-label="Close job">
											<button
												className="btn-outline btn-segmented__item btn-segmented__item--decline"
												onClick={() => setPendingCancel(selectedEntry)}
												disabled={actionsLocked}
												title="Cancel this job — the customer is notified"
											>
												<CrossIcon />
												Cancel
											</button>
											<button
												className="btn-outline btn-segmented__item btn-segmented__item--complete"
												onClick={() => setPendingComplete(selectedEntry)}
												disabled={actionsLocked}
												title="Mark this job as complete — the customer is notified"
											>
												<CheckIcon />
												Complete
											</button>
										</div>
										<button
											className="btn-outline"
											onClick={() => handleViewFiles(selectedEntry._id)}
											title="Open this job's downloaded files in File Explorer"
										>
											<FolderIcon />
											View files
										</button>
										{/* The per-job master switch replaces Print-all while
										    automated printing is driving this job. */}
										{autoDriving ? (
											<button
												className="btn-outline"
												onClick={() => setJobAutoPaused(selectedEntry._id, true)}
												title="Hold automated printing for this job only — the rest of the queue keeps printing"
											>
												<PauseIcon />
												Pause auto-print
											</button>
										) : autoHeld ? (
											<button
												className={needsAttention ? "btn-outline btn-outline-danger" : "btn-outline"}
												onClick={() => setJobAutoPaused(selectedEntry._id, false)}
												title={
													needsAttention
														? "A document failed — fix the problem, then resume automated printing for this job"
														: "Resume automated printing for this job"
												}
											>
												<PlayIcon />
												Resume auto-print
											</button>
										) : null}
										{autoDriving ? null : (
											// While the batch has queued docs the control is Stop; the
											// running state lives in the helper line below the button
											// (empty when idle). During the
											// post-stop drain (in-flight doc finishing, nothing queued)
											// it's Print-all again — clicking it simply resumes.
											// No printer dropdown here: each document routes to its
											// own service's printer — overriding is per document.
											<PrintSplitButton
												size="md"
												onPrint={handlePrintAll}
												showMenu={false}
												// Locked while an update waits for the current print.
												disabled={remainingCount === 0 || updateHold}
												showInfo
												info={hasQueued || actionsLocked ? "Printing…" : undefined}
												infoActive={hasQueued || actionsLocked}
												// Stop belongs to an operator batch only — documents
												// held by a per-job auto pause aren't running.
												stopMode={jobHasQueuedManualDocs(selectedEntry._id)}
												onStop={() => stopPrintJob(selectedEntry._id)}
												label={
													<>
														<PrinterIcon />
														Print
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
					title={`Cancel ${jobLabel(pendingCancel)}?`}
					message="The customer will be notified. This can't be undone."
					confirmLabel="Cancel job"
					// Not "Cancel" — that's what this dialog's action is called.
					cancelLabel="Keep job"
					tone="danger"
					onConfirm={handleConfirmCancel}
					onCancel={() => setPendingCancel(null)}
				/>
			)}

			{/* Cancelling is refused once a document has started printing; failing the
			    job (customer refunded) is the way out. */}
			{declineBlocked && (
				<ConfirmDialog
					title={`${capitalize(jobLabel(declineBlocked))} is already printing`}
					message="It can't be cancelled now. Mark it as failed instead to refund the customer."
					confirmLabel="Mark as failed"
					tone="danger"
					onConfirm={handleFailInstead}
					onCancel={() => setDeclineBlocked(null)}
				/>
			)}

			{pendingComplete && (
				PRE_PRINT_STATUSES.has(pendingComplete.rawStatus) ? (
					<ConfirmDialog
						title={`${capitalize(jobLabel(pendingComplete))} hasn't been printed`}
						message="Print it first, or complete it anyway. The customer will be notified that it's ready."
						confirmLabel="Complete anyway"
						tone="warning"
						onConfirm={handleForceComplete}
						onCancel={() => setPendingComplete(null)}
					/>
				) : (
					<ConfirmDialog
						title={`Complete ${jobLabel(pendingComplete)}?`}
						message="The customer will be notified that it's ready. This can't be undone."
						confirmLabel="Mark complete"
						onConfirm={handleConfirmComplete}
						onCancel={() => setPendingComplete(null)}
					/>
				)
			)}
		</>
	);
}

export default PrintJobsTab;
