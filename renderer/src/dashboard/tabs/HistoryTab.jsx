import { Fragment, useState, useEffect, useCallback, useRef } from "react";
import { transformJob } from "../jobUtils";
import ListColumn from "../components/ListColumn";
import WelcomePane from "../components/WelcomePane";
import JobDetailCard from "../components/JobDetailCard";
import EmptyState from "../components/EmptyState";
import JobListCard from "../components/JobListCard";
import RefreshButton from "../components/RefreshButton";
import StaleNote from "../components/StaleNote";
import { useNetStatus } from "../useNetStatus";

// The card shows only the time of day — the date is its group's header.
function formatHistoryTime(isoString) {
	return new Date(isoString).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// Local calendar day, so jobs group by the shop's day rather than UTC's.
function dayKey(isoString) {
	const d = new Date(isoString);
	return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// "Today", "Yesterday", else "Mon, Sep 28" — with the year once it isn't this one.
function formatDayHeader(isoString) {
	const d = new Date(isoString);
	const now = new Date();
	const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
	if (dayKey(d) === dayKey(now)) return "Today";
	if (dayKey(d) === dayKey(yesterday)) return "Yesterday";
	return d.toLocaleDateString("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
		...(d.getFullYear() !== now.getFullYear() && { year: "numeric" }),
	});
}

// Splits the (newest-first) list into consecutive same-day groups.
function groupByDay(entries) {
	const groups = [];
	for (const entry of entries) {
		const key = dayKey(entry.createdAt);
		const last = groups[groups.length - 1];
		if (last?.key === key) last.entries.push(entry);
		else groups.push({ key, label: formatDayHeader(entry.createdAt), entries: [entry] });
	}
	return groups;
}

function HistoryTab() {
	const [entries, setEntries] = useState([]);
	const [loading, setLoading] = useState(true);
	// Nothing could be loaded (no saved copy either) — never shown as "no history".
	const [error, setError] = useState(null);
	// { stale, fetchedAt } — the list is the copy saved before the connection dropped.
	const [saved, setSaved] = useState({ stale: false, fetchedAt: null });
	const net = useNetStatus();
	const [selectedEntry, setSelectedEntry] = useState(null);

	const mounted = useRef(true);

	// Loads the history list. The first load shows the loading state; a manual
	// refresh (`silent`) keeps the current list on screen until the new one lands.
	const loadHistory = useCallback(async ({ silent = false } = {}) => {
		if (!silent) setLoading(true);
		try {
			const result = await window.electronAPI.fetchHistory();
			if (mounted.current && !result.success) setError(result.message || "Couldn't load history.");
			if (mounted.current && result.success) {
				setError(null);
				setSaved({ stale: !!result.stale, fetchedAt: result.fetchedAt || null });
				const jobs = (result.data || [])
					.map(transformJob)
					.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
				setEntries(jobs);
				// Keep the open job in step with the refreshed list.
				setSelectedEntry((current) => (current ? jobs.find((j) => j._id === current._id) || null : current));
			}
		} catch (err) {
			console.error("[Renderer] failed to load history:", err);
			if (mounted.current) setError("Couldn't load history.");
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

	// Back online: replace a saved (or missing) list with the real one.
	useEffect(() => {
		if (net.online && (saved.stale || error)) loadHistory({ silent: true });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [net.online]);

	return (
		<>
			<ListColumn
				title="History"
				count={entries.length}
				action={<RefreshButton onRefresh={() => loadHistory({ silent: true })} label="Refresh history" />}
				className="db-list--jobs"
				bodyClassName="db-list__entries--column"
			>
				<StaleNote stale={saved.stale} fetchedAt={saved.fetchedAt} />
				{loading ? (
					<div className="db-coming-soon">
						<div className="spinner spinner--dark" />
						<p>Loading history…</p>
					</div>
				) : error && entries.length === 0 ? (
					<div className="db-coming-soon">
						<p>{net.online ? error : "You're offline — history will appear once the connection is back."}</p>
						<button type="button" className="btn-outline btn-sm" onClick={() => loadHistory()}>
							Try again
						</button>
					</div>
				) : entries.length === 0 ? (
					<EmptyState art="history" title="No print history" />
				) : (
					groupByDay(entries).map((group) => (
						<Fragment key={group.key}>
							<div className="db-list__section">
								<span className="db-list__section-title">{group.label}</span>
								<span className="db-list__section-count">{group.entries.length}</span>
							</div>
							{group.entries.map((entry) => (
								<JobListCard
									key={entry._id}
									entry={entry}
									time={formatHistoryTime(entry.createdAt)}
									selected={selectedEntry?._id === entry._id}
									onClick={() => setSelectedEntry(entry)}
								/>
							))}
						</Fragment>
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
