import React, { useState } from "react";
import { useJobs } from "../JobsContext";
import { ACTIVE_STATUSES } from "../jobUtils";
import ListColumn from "../components/ListColumn";
import WelcomePane from "../components/WelcomePane";
import JobDetailCard from "../components/JobDetailCard";
import ConfirmDialog from "../components/ConfirmDialog";
import { PrinterIcon, TrashIcon } from "../icons";

// Print Jobs tab: active job queue list on the left, job details + accept/decline
// actions on the right. Print spooling is simulated locally.
function PrintJobsTab() {
	const { printJobs, setPrintJobs, jobsLoading } = useJobs();
	const [selectedEntry, setSelectedEntry] = useState(null);

	// Simulated print spooling states: jobId -> "printing" | "success" | "cancelled"
	const [jobSpoolState, setJobSpoolState] = useState({});

	// Job pending a cancel confirmation (the "Are you sure?" dialog).
	const [pendingCancel, setPendingCancel] = useState(null);

	// Oldest job first, so #1 is the next one up in the queue. The top (oldest)
	// job gets a special dashed highlight below.
	const entries = printJobs
		.filter((j) => ACTIVE_STATUSES.has(j.rawStatus))
		.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

	const triggerSimulatedPrint = (jobId) => {
		if (jobSpoolState[jobId] === "printing") return;

		setJobSpoolState((prev) => ({ ...prev, [jobId]: "printing" }));

		setTimeout(() => {
			setPrintJobs((prevJobs) =>
				prevJobs.map((j) => (j._id === jobId ? { ...j, status: "processing", rawStatus: "processing" } : j))
			);
			setSelectedEntry((prev) => (prev?._id === jobId ? { ...prev, status: "processing", rawStatus: "processing" } : prev));
		}, 2000);

		setTimeout(() => {
			setPrintJobs((prevJobs) =>
				prevJobs.map((j) => (j._id === jobId ? { ...j, status: "completed", rawStatus: "completed" } : j))
			);
			setJobSpoolState((prev) => ({ ...prev, [jobId]: "success" }));
			setSelectedEntry((prev) => (prev?._id === jobId ? { ...prev, status: "completed", rawStatus: "completed" } : prev));

			setTimeout(() => {
				setJobSpoolState((prev) => ({ ...prev, [jobId]: null }));
			}, 3000);
		}, 4500);
	};

	// Confirmed cancel: optimistically drop the job from the active list and tell
	// the backend. If the request fails, the optimistic change is reverted.
	const handleConfirmCancel = async () => {
		const job = pendingCancel;
		if (!job) return;
		setPendingCancel(null);
		setSelectedEntry(null);

		setPrintJobs((prevJobs) =>
			prevJobs.map((j) => (j._id === job._id ? { ...j, status: "completed", rawStatus: "cancelled" } : j))
		);

		try {
			const result = await window.electronAPI.updateJobStatus(job._id, "cancelled");
			if (!result?.success) throw new Error(result?.message || "request failed");
		} catch (err) {
			console.error("[Renderer] failed to cancel job:", err);
			// Revert to the job's original status.
			setPrintJobs((prevJobs) =>
				prevJobs.map((j) => (j._id === job._id ? { ...j, status: job.status, rawStatus: job.rawStatus } : j))
			);
		}
	};

	return (
		<>
			<ListColumn title="Print Jobs" count={entries.length}>
				{jobsLoading ? (
					<div className="db-coming-soon">
						<div className="spinner spinner--dark" />
						<p>Loading jobs…</p>
					</div>
				) : entries.length === 0 ? (
					<div className="db-coming-soon">
						<p>No active print jobs</p>
					</div>
				) : (
					entries.map((entry, index) => (
						<button
							key={entry._id}
							className={`db-entry db-entry--job ${selectedEntry?._id === entry._id ? "db-entry--active" : ""} ${index === 0 ? "db-entry--top" : ""}`}
							onClick={() => setSelectedEntry(entry)}
						>
							<span className="db-entry__qnum">{index + 1}</span>
							<div className="db-entry__info">
								<div className="db-entry__line">
									<span className="db-entry__name">{entry.fileName}</span>
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
					))
				)}
			</ListColumn>

			<div className="db-detail">
				{selectedEntry ? (
					<JobDetailCard
						entry={selectedEntry}
						spoolState={jobSpoolState[selectedEntry._id]}
						actions={
							selectedEntry.status !== "completed" ? (
								<>
									<button
										className="btn-outline btn-outline-danger"
										onClick={() => setPendingCancel(selectedEntry)}
										disabled={jobSpoolState[selectedEntry._id] === "printing"}
									>
										<TrashIcon />
										Decline Job
									</button>
									<button
										className="btn-gradient"
										onClick={() => triggerSimulatedPrint(selectedEntry._id)}
										disabled={jobSpoolState[selectedEntry._id] === "printing"}
									>
										{jobSpoolState[selectedEntry._id] === "printing" ? (
											<>
												<div className="spinner spinner--dark" style={{ borderTopColor: "#111b21", width: "14px", height: "14px" }} />
												Printing...
											</>
										) : (
											<>
												<PrinterIcon />
												Accept & Print
											</>
										)}
									</button>
								</>
							) : (
								<button
									className="btn-outline"
									onClick={() => triggerSimulatedPrint(selectedEntry._id)}
								>
									<PrinterIcon />
									Reprint Document
								</button>
							)
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
		</>
	);
}

export default PrintJobsTab;
