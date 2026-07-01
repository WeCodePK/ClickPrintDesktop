import { useState } from "react";
import { useJobs } from "../JobsContext";
import { ACTIVE_STATUSES } from "../jobUtils";
import ListColumn from "../components/ListColumn";
import WelcomePane from "../components/WelcomePane";
import JobDetailCard from "../components/JobDetailCard";
import ConfirmDialog from "../components/ConfirmDialog";
import { CheckIcon, TrashIcon, SearchIcon } from "../icons";

// Print Jobs tab: active job queue list on the left, job details on the right.
// Each file can be previewed in the OS viewer or printed silently with its own
// settings; the whole job can be declined or marked complete from the header.
function PrintJobsTab() {
	const { printJobs, setPrintJobs, jobsLoading } = useJobs();
	const [selectedEntry, setSelectedEntry] = useState(null);

	// Job pending a decline confirmation (the "Are you sure?" dialog).
	const [pendingCancel, setPendingCancel] = useState(null);

	// Job pending a mark-complete confirmation.
	const [pendingComplete, setPendingComplete] = useState(null);

	// Phone-number search query.
	const [query, setQuery] = useState("");

	// Oldest job first, so #1 is the next one up in the queue. The top (oldest)
	// job gets a special dashed highlight below.
	const entries = printJobs
		.filter((j) => ACTIVE_STATUSES.has(j.rawStatus))
		.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
		.map((job) => {
			const n = job.createdBy?.number || "";
			const sn = n.startsWith("0") ? n.slice(1) : n;
			const formattedNumber = "0".concat(sn.slice(2));
			return { ...job, formattedNumber };
		});

	// Apply the phone-number search (also matches the customer name). The queue
	// numbering / "top" highlight still reflect each job's position in the full
	// queue, not the filtered view.
	const q = query.trim().toLowerCase();
	const visible = q
		? entries.filter((e) =>
				`${e.formattedNumber || ""} ${e.createdBy?.name || ""}`.toLowerCase().includes(q)
			)
		: entries;

	// Optimistically applies a status change to a job, both in the list and in the
	// current selection. Returns a revert function for use on request failure.
	const applyStatus = (jobId, status, rawStatus) => {
		const prevJob = printJobs.find((j) => j._id === jobId);
		setPrintJobs((prevJobs) =>
			prevJobs.map((j) => (j._id === jobId ? { ...j, status, rawStatus } : j))
		);
		setSelectedEntry((prev) => (prev?._id === jobId ? { ...prev, status, rawStatus } : prev));
		return () => {
			if (!prevJob) return;
			setPrintJobs((prevJobs) =>
				prevJobs.map((j) => (j._id === jobId ? { ...j, status: prevJob.status, rawStatus: prevJob.rawStatus } : j))
			);
		};
	};

	// Confirmed decline: optimistically drop the job from the active list and tell
	// the backend. If the request fails, the optimistic change is reverted.
	const handleConfirmCancel = async () => {
		const job = pendingCancel;
		if (!job) return;
		setPendingCancel(null);
		setSelectedEntry(null);

		const revert = applyStatus(job._id, "completed", "cancelled");
		try {
			const result = await window.electronAPI.updateJobStatus(job._id, "cancelled");
			if (!result?.success) throw new Error(result?.message || "request failed");
		} catch (err) {
			console.error("[Renderer] failed to cancel job:", err);
			revert();
		}
	};

	// Confirmed complete: drop the job from the active list, hide its detail pane
	// and notify the backend. Reverted if the backend rejects the change.
	const handleConfirmComplete = async () => {
		const job = pendingComplete;
		if (!job) return;
		setPendingComplete(null);
		setSelectedEntry(null);

		const revert = applyStatus(job._id, "completed", "completed");
		try {
			const result = await window.electronAPI.updateJobStatus(job._id, "completed");
			if (!result?.success) throw new Error(result?.message || "request failed");
		} catch (err) {
			console.error("[Renderer] failed to mark job complete:", err);
			revert();
		}
	};

	// Opens a single file in the OS default viewer. Errors are logged, not shown.
	const handlePreviewFile = async (file) => {
		try {
			const result = await window.electronAPI.openFile(file.fileId);
			if (!result?.success) throw new Error(result?.message || "open failed");
		} catch (err) {
			console.error("[Renderer] failed to preview file:", err);
		}
	};

	// Silently prints a file with its own settings (page size, range, color,
	// copies, duplex) to the default printer, then moves the job to "printing" on
	// the backend. Status only changes if the print succeeds. Errors are logged.
	const handlePrintFile = async (file) => {
		const job = selectedEntry;
		if (!job) return;

		try {
			const result = await window.electronAPI.printFile(file.fileId, file.settings);
			if (!result?.success) throw new Error(result?.message || "print failed");
		} catch (err) {
			console.error("[Renderer] failed to print file:", err);
			return;
		}

		applyStatus(job._id, "processing", "printing");
		try {
			const result = await window.electronAPI.updateJobStatus(job._id, "printing");
			if (!result?.success) throw new Error(result?.message || "request failed");
		} catch (err) {
			console.error("[Renderer] failed to set job printing:", err);
		}
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
								className={`db-entry db-entry--job ${selectedEntry?._id === entry._id ? "db-entry--active" : ""} ${queueIndex === 0 ? "db-entry--top" : ""}`}
								onClick={() => setSelectedEntry(entry)}
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
											{entry.copies} {entry.copies === 1 ? "copy" : "copies"} · {entry.color ? "Color" : "B&W"} · {entry.filesCount} {entry.filesCount === 1 ? "file" : "files"}
										</span>
										<span className="db-entry__right">
											<span className="db-entry__time">{entry.time}</span>
											<span className={`db-entry__dot db-entry__dot--${entry.status}`} />
										</span>
									</div>
								</div>
							</button>
						);
					})
				)}
			</ListColumn>

			<div className="db-detail">
				{selectedEntry ? (
					<JobDetailCard
						entry={selectedEntry}
						onPreviewFile={handlePreviewFile}
						onPrintFile={handlePrintFile}
						headerActions={
							selectedEntry.status !== "completed" ? (
								<>
									<button
										className="btn-outline btn-outline-danger"
										onClick={() => setPendingCancel(selectedEntry)}
									>
										<TrashIcon />
										Decline Job
									</button>
									<button
										className="btn-gradient"
										onClick={() => setPendingComplete(selectedEntry)}
									>
										<CheckIcon />
										Mark as Complete
									</button>
								</>
							) : null
						}
					/>
				) : (
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
				<ConfirmDialog
					title="Mark this job as complete?"
					message={`Are you sure "${pendingComplete.fileName}" is done? This action can't be undone, and the customer will be notified that their print is ready.`}
					confirmLabel="Yes, mark complete"
					cancelLabel="Not yet"
					onConfirm={handleConfirmComplete}
					onCancel={() => setPendingComplete(null)}
				/>
			)}
		</>
	);
}

export default PrintJobsTab;
