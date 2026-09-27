import { useState, useEffect, useCallback, useRef } from "react";
import { transformJob } from "../jobUtils";
import ListColumn from "../components/ListColumn";
import WelcomePane from "../components/WelcomePane";
import JobDetailCard from "../components/JobDetailCard";
import EmptyState from "../components/EmptyState";
import JobListCard from "../components/JobListCard";
import RefreshButton from "../components/RefreshButton";

function formatHistoryDate(isoString) {
	return new Date(isoString).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function HistoryTab() {
	const [entries, setEntries] = useState([]);
	const [loading, setLoading] = useState(true);
	const [selectedEntry, setSelectedEntry] = useState(null);

	const mounted = useRef(true);

	// Loads the history list. The first load shows the loading state; a manual
	// refresh (`silent`) keeps the current list on screen until the new one lands.
	const loadHistory = useCallback(async ({ silent = false } = {}) => {
		if (!silent) setLoading(true);
		try {
			const result = await window.electronAPI.fetchHistory();
			if (mounted.current && result.success) {
				const jobs = (result.data || [])
					.map(transformJob)
					.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
				setEntries(jobs);
				// Keep the open job in step with the refreshed list.
				setSelectedEntry((current) => (current ? jobs.find((j) => j._id === current._id) || null : current));
			}
		} catch (err) {
			console.error("[Renderer] failed to load history:", err);
		} finally {
			if (mounted.current && !silent) setLoading(false);
		}
	}, []);

	useEffect(() => {
		mounted.current = true;
		loadHistory();
		return () => {
			mounted.current = false;
		};
	}, [loadHistory]);

	return (
		<>
			<ListColumn
				title="History"
				count={entries.length}
				action={<RefreshButton onRefresh={() => loadHistory({ silent: true })} label="Refresh history" />}
				className="db-list--jobs"
				bodyClassName="db-list__entries--column"
			>
				{loading ? (
					<div className="db-coming-soon">
						<div className="spinner spinner--dark" />
						<p>Loading history…</p>
					</div>
				) : entries.length === 0 ? (
					<EmptyState art="history" title="No print history" />
				) : (
					entries.map((entry) => (
						<JobListCard
							key={entry._id}
							entry={entry}
							time={formatHistoryDate(entry.createdAt)}
							selected={selectedEntry?._id === entry._id}
							onClick={() => setSelectedEntry(entry)}
						/>
					))
				)}
			</ListColumn>

			<div className="db-detail">
				{selectedEntry ? (
					<JobDetailCard entry={selectedEntry} showPreview={false}/>
				) : (
					<WelcomePane />
				)}
			</div>
		</>
	);
}

export default HistoryTab;
