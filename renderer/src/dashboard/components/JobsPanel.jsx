import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { useJobs } from "../JobsContext";
import { transformJob } from "../jobUtils";
import { SearchIcon, EyeIcon, ChevronDownIcon } from "../icons";

// Toggleable columns for the Jobs & History table (order they render in).
const JOBTBL_COLUMNS = [
	{ key: "status", label: "Status" },
	{ key: "createdBy", label: "Created By" },
	{ key: "cost", label: "Cost" },
	{ key: "createdAt", label: "Created At" },
	{ key: "actions", label: "Actions" },
];

const JOBTBL_PAGE_SIZES = [5, 8, 10, 25, 50];

const rupees = (n) => `Rs. ${Math.round(n).toLocaleString("en-US")}`;

function createdByLabel(item) {
	const by = item.createdBy;
	if (!by) return "—";
	return by.name || by.number || "—";
}

function formatWhen(iso) {
	if (!iso) return "—";
	return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

function JobStatusBadge({ status }) {
	const s = (status || "").toLowerCase();
	const cls =
		s === "completed" ? "jobtbl-status--completed" :
		s === "cancelled" || s === "failed" ? "jobtbl-status--danger" :
		s === "printing" || s === "processing" ? "jobtbl-status--active" :
		"jobtbl-status--pending";
	return <span className={`jobtbl-status ${cls}`}>{status}</span>;
}

// Combined jobs + history browser: tabbed, searchable, paginated table mirroring
// the admin panel's job/history list — read-only summary, not an operational view
// (job actions like cancel/complete stay in the Print Jobs tab).
function JobsPanel() {
	const { printJobs, jobsLoading } = useJobs();
	const [historyJobs, setHistoryJobs] = useState([]);
	const [historyLoading, setHistoryLoading] = useState(true);

	const loadHistoryJobs = useCallback(async () => {
		setHistoryLoading(true);
		try {
			const result = await window.electronAPI.fetchHistory();
			if (result.success) setHistoryJobs((result.data || []).map(transformJob));
		} catch (err) {
			console.error("[Renderer] failed to load history table:", err);
		} finally {
			setHistoryLoading(false);
		}
	}, []);

	useEffect(() => {
		loadHistoryJobs();
	}, [loadHistoryJobs]);

	const [tab, setTab] = useState("jobs");
	const [query, setQuery] = useState("");
	const [view, setView] = useState("all");
	const [page, setPage] = useState(1);
	const [pageSize, setPageSize] = useState(JOBTBL_PAGE_SIZES[1]);
	const [selected, setSelected] = useState(null);

	// Which columns render, beyond the always-present "#" index.
	const [cols, setCols] = useState({
		status: true,
		createdBy: true,
		cost: true,
		createdAt: true,
		actions: true,
	});
	const [colsOpen, setColsOpen] = useState(false);
	const colsRef = useRef(null);

	useEffect(() => {
		if (!colsOpen) return;
		const onOutside = (e) => {
			if (colsRef.current && !colsRef.current.contains(e.target)) setColsOpen(false);
		};
		document.addEventListener("mousedown", onOutside);
		return () => document.removeEventListener("mousedown", onOutside);
	}, [colsOpen]);

	const loading = tab === "jobs" ? jobsLoading : historyLoading;
	const source = tab === "jobs" ? printJobs : historyJobs;

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		return source.filter((item) => {
			const matchStatus = view === "all" || item.rawStatus === view;
			const matchQuery =
				!q ||
				(item.createdBy?.name || "").toLowerCase().includes(q) ||
				(item.createdBy?.number || "").includes(q);
			return matchStatus && matchQuery;
		});
	}, [source, view, query]);

	useEffect(() => {
		setPage(1);
	}, [tab, view, query, pageSize]);

	const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
	const paginated = visible.slice((page - 1) * pageSize, page * pageSize);
	const colSpan = 1 + Object.values(cols).filter(Boolean).length;

	const downloadCSV = () => {
		const headers = ["#"];
		if (cols.status) headers.push("Status");
		if (cols.createdBy) headers.push("Created By");
		if (cols.cost) headers.push("Cost");
		if (cols.createdAt) headers.push("Created At");

		const rows = visible.map((item, index) => {
			const row = [String(index + 1)];
			if (cols.status) row.push(`"${item.rawStatus}"`);
			if (cols.createdBy) row.push(`"${createdByLabel(item)}"`);
			if (cols.cost) row.push(`"${item.price}"`);
			if (cols.createdAt) row.push(`"${formatWhen(item.createdAt)}"`);
			return row.join(",");
		});

		const csvContent = [headers.join(","), ...rows].join("\n");
		const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.setAttribute("download", `${tab}-report.csv`);
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
		URL.revokeObjectURL(url);
	};

	const downloadPDF = () => {
		const doc = new jsPDF();
		doc.text(`${tab === "jobs" ? "Jobs" : "History"} Report`, 14, 15);

		const headers = ["#"];
		if (cols.status) headers.push("Status");
		if (cols.createdBy) headers.push("Created By");
		if (cols.cost) headers.push("Cost");
		if (cols.createdAt) headers.push("Created At");

		const tableData = visible.map((item, index) => {
			const row = [String(index + 1)];
			if (cols.status) row.push(item.rawStatus);
			if (cols.createdBy) row.push(createdByLabel(item));
			if (cols.cost) row.push(rupees(item.price));
			if (cols.createdAt) row.push(formatWhen(item.createdAt));
			return row;
		});

		autoTable(doc, {
			head: [headers],
			body: tableData,
			startY: 20,
			styles: { fontSize: 8 },
			headStyles: { fillColor: [0, 217, 163] },
		});

		doc.save(`${tab}-report.pdf`);
	};

	return (
		<div className="panel panel--span2">
			<div className="panel__head">
				<div>
					<h3 className="panel__title">Jobs &amp; History</h3>
					<span className="panel__hint">Browse and search every print job</span>
				</div>
				<div className="range-switch">
					<button
						type="button"
						className={`range-switch__btn ${tab === "jobs" ? "range-switch__btn--active" : ""}`}
						onClick={() => setTab("jobs")}
					>
						Jobs
					</button>
					<button
						type="button"
						className={`range-switch__btn ${tab === "history" ? "range-switch__btn--active" : ""}`}
						onClick={() => setTab("history")}
					>
						History
					</button>
				</div>
			</div>

			<div className="jobtbl-toolbar">
				<div className="jobtbl-toolbar__left">
					<div className="db-search">
						<SearchIcon />
						<input
							className="db-search__input"
							type="text"
							placeholder="Search by name or number..."
							value={query}
							onChange={(e) => setQuery(e.target.value)}
						/>
						{query && (
							<button className="db-search__clear" onClick={() => setQuery("")} title="Clear">
								×
							</button>
						)}
					</div>
					<select className="form-input jobtbl-filter" value={view} onChange={(e) => setView(e.target.value)}>
						<option value="all">All {tab === "jobs" ? "Jobs" : "History"}</option>
						{tab === "jobs" ? (
							<>
								<option value="queued">Queued</option>
								<option value="printing">Printing</option>
							</>
						) : (
							<>
								<option value="completed">Completed</option>
								<option value="cancelled">Cancelled</option>
								<option value="failed">Failed</option>
							</>
						)}
					</select>

					<div className="jobtbl-dropdown" ref={colsRef}>
						<button
							type="button"
							className="btn-outline jobtbl-toolbar-btn"
							onClick={() => setColsOpen((o) => !o)}
						>
							Columns
							<ChevronDownIcon />
						</button>
						{colsOpen && (
							<div className="jobtbl-dropdown__menu jobtbl-dropdown__menu--cols">
								{JOBTBL_COLUMNS.map(({ key, label }) => (
									<label key={key} className="jobtbl-col-option">
										<input
											type="checkbox"
											checked={cols[key]}
											onChange={() => setCols((c) => ({ ...c, [key]: !c[key] }))}
										/>
										{label}
									</label>
								))}
							</div>
						)}
					</div>
				</div>

				<div className="jobtbl-toolbar__right">
					<div className="jobtbl-dropdown jobtbl-dropdown--hover">
						<button type="button" className="jobtbl-download-btn">
							Download as CSV/PDF
							<ChevronDownIcon />
						</button>
						<div className="jobtbl-dropdown__menu">
							<button type="button" onClick={downloadCSV}>CSV</button>
							<button type="button" onClick={downloadPDF}>PDF</button>
						</div>
					</div>
				</div>
			</div>

			<div className="jobtbl-wrap">
				<table className="jobtbl">
					<thead>
						<tr>
							<th>#</th>
							{cols.status && <th>Status</th>}
							{cols.createdBy && <th>Created by</th>}
							{cols.cost && <th>Cost</th>}
							{cols.createdAt && <th>Created at</th>}
							{cols.actions && <th>Actions</th>}
						</tr>
					</thead>
					<tbody>
						{loading ? (
							<tr>
								<td colSpan={colSpan} className="jobtbl__empty">Loading {tab}…</td>
							</tr>
						) : paginated.length === 0 ? (
							<tr>
								<td colSpan={colSpan} className="jobtbl__empty">No {tab} in this view.</td>
							</tr>
						) : (
							paginated.map((item, i) => (
								<tr key={item._id} onClick={() => setSelected(item)}>
									<td>{(page - 1) * pageSize + i + 1}</td>
									{cols.status && <td><JobStatusBadge status={item.rawStatus} /></td>}
									{cols.createdBy && (
										<td>
											<div>{createdByLabel(item)}</div>
											{item.createdBy?.number && <div className="jobtbl__sub">{item.createdBy.number}</div>}
										</td>
									)}
									{cols.cost && <td>{rupees(item.price)}</td>}
									{cols.createdAt && <td>{formatWhen(item.createdAt)}</td>}
									{cols.actions && (
										<td>
											<button
												className="jobtbl__view-btn"
												onClick={(e) => { e.stopPropagation(); setSelected(item); }}
												title="View details"
											>
												<EyeIcon />
											</button>
										</td>
									)}
								</tr>
							))
						)}
					</tbody>
				</table>
			</div>

			{!loading && paginated.length > 0 && (
				<div className="jobtbl-pagination">
					<div className="jobtbl-pagination__left">
						<span className="jobtbl-pagination__info">
							Showing {(page - 1) * pageSize + 1} to {Math.min(page * pageSize, visible.length)} of {visible.length} results
						</span>
						<select
							className="jobtbl-pagesize"
							value={pageSize}
							onChange={(e) => setPageSize(Number(e.target.value))}
						>
							{JOBTBL_PAGE_SIZES.map((n) => (
								<option key={n} value={n}>{n} / page</option>
							))}
						</select>
					</div>
					<div className="jobtbl-pagination__btns">
						<button className="btn-outline" disabled={page === 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
							Previous
						</button>
						<span className="jobtbl-pagination__page">Page {page} of {totalPages}</span>
						<button className="btn-outline" disabled={page === totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
							Next
						</button>
					</div>
				</div>
			)}

			{selected && (
				<div className="modal-overlay" onClick={() => setSelected(null)}>
					<div className="modal-card modal-card--wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
						<h3 className="modal-title">{tab === "jobs" ? "Job Details" : "History Details"}</h3>
						<div className="jobtbl-detail-grid">
							<div>
								<span className="jobtbl-detail-label">Status</span>
								<JobStatusBadge status={selected.rawStatus} />
							</div>
							<div>
								<span className="jobtbl-detail-label">Created by</span>
								<p>{createdByLabel(selected)}</p>
							</div>
							<div>
								<span className="jobtbl-detail-label">Cost</span>
								<p>{rupees(selected.price)}</p>
							</div>
							<div>
								<span className="jobtbl-detail-label">Created at</span>
								<p>{formatWhen(selected.createdAt)}</p>
							</div>
							<div>
								<span className="jobtbl-detail-label">File</span>
								<p>{selected.fileName}</p>
							</div>
							<div>
								<span className="jobtbl-detail-label">Copies</span>
								<p>{selected.copies}</p>
							</div>
						</div>
						<div className="modal-actions">
							<button className="btn-gradient" onClick={() => setSelected(null)}>Close</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

export default JobsPanel;
