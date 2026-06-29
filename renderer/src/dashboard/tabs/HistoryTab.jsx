import React, { useState, useEffect } from "react";
import { transformJob } from "../jobUtils";
import ListColumn from "../components/ListColumn";
import WelcomePane from "../components/WelcomePane";
import JobDetailCard from "../components/JobDetailCard";
import { HistoryGlyph } from "../icons";

function formatHistoryDate(isoString) {
	return new Date(isoString).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// History tab: past (completed/cancelled) jobs fetched from GET /api/history.
// Re-fetched on each visit since navigating tabs remounts the route.
function HistoryTab() {
	const [entries, setEntries] = useState([]);
	const [loading, setLoading] = useState(true);
	const [selectedEntry, setSelectedEntry] = useState(null);

	useEffect(() => {
		let cancelled = false;

		async function loadHistory() {
			setLoading(true);
			try {
				const result = await window.electronAPI.fetchHistory();
				if (!cancelled && result.success) {
					const jobs = (result.data || [])
						.map(transformJob)
						.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
					setEntries(jobs);
				}
			} catch (err) {
				console.error("[Renderer] failed to load history:", err);
			} finally {
				if (!cancelled) setLoading(false);
			}
		}

		loadHistory();
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<>
			<ListColumn title="History" count={entries.length}>
				{loading ? (
					<div className="db-coming-soon">
						<div className="spinner spinner--dark" />
						<p>Loading history…</p>
					</div>
				) : entries.length === 0 ? (
					<div className="db-coming-soon">
						<p>No print history</p>
					</div>
				) : (
					entries.map((entry) => (
						<button
							key={entry._id}
							className={`db-entry ${selectedEntry?._id === entry._id ? "db-entry--active" : ""}`}
							onClick={() => setSelectedEntry(entry)}
						>
							<div className="db-entry__avatar db-entry__avatar--secondary">
								<HistoryGlyph />
							</div>
							<div className="db-entry__info">
								<span className="db-entry__name">{entry.fileName}</span>
								<span className="db-entry__meta" style={{ textTransform: "capitalize" }}>
									{entry.rawStatus} · Rs. {entry.price}
								</span>
							</div>
							<div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
								<span className="db-entry__time">{formatHistoryDate(entry.createdAt)}</span>
							</div>
						</button>
					))
				)}
			</ListColumn>

			<div className="db-detail">
				{selectedEntry ? (
					<JobDetailCard entry={selectedEntry} />
				) : (
					<WelcomePane />
				)}
			</div>
		</>
	);
}

export default HistoryTab;
