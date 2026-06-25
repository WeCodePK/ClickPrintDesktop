import React, { useState, useEffect } from "react";

// ── Job status mapping helpers ────────────────────────────────────────────────
const ACTIVE_STATUSES = new Set(["draft", "submitted", "processing"]);

function mapStatus(serverStatus) {
	if (serverStatus === "draft" || serverStatus === "submitted") return "pending";
	if (serverStatus === "processing") return "processing";
	return "completed";
}

function formatTime(isoString) {
	return new Date(isoString).toLocaleTimeString("en-US", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: true,
	});
}

function transformJob(job) {
	const firstFile = job.files?.[0];
	const s = firstFile?.settings || {};
	return {
		_id: job._id,
		fileName: firstFile ? firstFile.hash.slice(0, 15) + "…" : "Document",
		copies: s.numberOfCopies || 1,
		color: s.color || false,
		status: mapStatus(job.status),
		rawStatus: job.status,
		time: formatTime(job.createdAt),
		pageType: s.pageType || "A4",
		orientation: s.orientation || "portrait",
		pagesPerSheet: s.pagesPerSheet || 1,
		sidedness: s.sidedness || "single",
		pageSelection: s.pageSelection || "All pages",
		filesCount: job.files?.length || 1,
		price: job.price || (s.numberOfCopies || 1) * (s.color ? 30 : 10),
		note: job.note || "",
	};
}

const DUMMY_HISTORY = [
	{
		_id: "h1",
		fileName: "Biology Notes.pdf",
		copies: 1,
		color: false,
		status: "completed",
		rawStatus: "completed",
		time: "2h ago",
		pageType: "A4",
		orientation: "portrait",
		sidedness: "single",
		filesCount: 1,
		price: 100,
	},
	{
		_id: "h2",
		fileName: "CS Assignment.pdf",
		copies: 2,
		color: true,
		status: "completed",
		rawStatus: "completed",
		time: "5h ago",
		pageType: "A4",
		orientation: "portrait",
		sidedness: "double",
		filesCount: 1,
		price: 160,
	},
	{
		_id: "h3",
		fileName: "Invitation Card.pdf",
		copies: 10,
		color: true,
		status: "completed",
		rawStatus: "completed",
		time: "Yesterday",
		pageType: "A5",
		orientation: "landscape",
		sidedness: "single",
		filesCount: 1,
		price: 500,
	},
];

const DUMMY_PRINTERS = [
	{
		_id: "p1",
		name: "Receipt Thermal XP-80",
		status: "online",
		type: "Thermal Receipt",
		ipAddress: "192.168.1.150",
		toner: 94,
		paperSize: "80mm Roll",
		location: "Main Counter",
	},
	{
		_id: "p2",
		name: "HP LaserJet Pro M404dn",
		status: "online",
		type: "Laser B&W",
		ipAddress: "192.168.1.155",
		toner: 42,
		paperSize: "A4 / Letter",
		location: "Back Office Office",
	},
	{
		_id: "p3",
		name: "Epson L3250 EcoTank",
		status: "offline",
		type: "Inkjet Color",
		ipAddress: "192.168.1.160",
		toner: 80,
		paperSize: "A4 / A5 / Photo",
		location: "Print Desk 1",
	},
];

// ── Icons ───────────────────────────────────────────────────────────────────

const HomeIcon = () => (
	<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
		<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
		<polyline points="9 22 9 12 15 12 15 22" />
	</svg>
);

const PrintJobsIcon = () => (
	<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
		<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
		<polyline points="14 2 14 8 20 8" />
		<line x1="16" y1="13" x2="8" y2="13" />
		<line x1="16" y1="17" x2="8" y2="17" />
		<polyline points="10 9 9 9 8 9" />
	</svg>
);

const PrinterIcon = () => (
	<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
		<polyline points="6 9 6 2 18 2 18 9" />
		<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
		<rect x="6" y="14" width="12" height="8" />
		<circle cx="18" cy="9" r="1" fill="currentColor" />
	</svg>
);

const HistoryIcon = () => (
	<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
		<polyline points="12 8 12 12 14 14" />
		<path d="M3.05 11a9 9 0 1 0 .5-4H4.5" />
		<polyline points="1 7 3 11 7 9" />
	</svg>
);

const SettingsIcon = () => (
	<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
		<circle cx="12" cy="12" r="3" />
		<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
	</svg>
);

const LogoutIcon = () => (
	<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
		<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
		<polyline points="16 17 21 12 16 7" />
		<line x1="21" y1="12" x2="9" y2="12" />
	</svg>
);

const IpIcon = () => (
	<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
		<rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
		<rect x="6" y="14" width="12" height="8" rx="2" ry="2" />
		<line x1="6" y1="6" x2="6.01" y2="6" strokeWidth="3" />
		<line x1="18" y1="18" x2="18.01" y2="18" strokeWidth="3" />
	</svg>
);

const PaperIcon = () => (
	<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
		<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
		<polyline points="14 2 14 8 20 8" />
	</svg>
);

const LocIcon = () => (
	<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
		<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
		<circle cx="12" cy="10" r="3" />
	</svg>
);

const CheckIcon = () => (
	<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
		<polyline points="20 6 9 17 4 12" />
	</svg>
);

const TrashIcon = () => (
	<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
		<polyline points="3 6 5 6 21 6" />
		<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
	</svg>
);

// ── Component ────────────────────────────────────────────────────────────────

function DashboardScreen({ shopProfile, onLogout }) {
	const [activeTab, setActiveTab] = useState("printJobs"); // default view
	const [selectedEntry, setSelectedEntry] = useState(null);

	// Live job list — populated from GET /api/jobs, kept up-to-date via SSE
	const [printJobs, setPrintJobs] = useState([]);
	const [jobsLoading, setJobsLoading] = useState(true);

	// Simulated print spooling states: jobId -> "printing" | "success" | "cancelled"
	const [jobSpoolState, setJobSpoolState] = useState({});
	const [simulatedPrinterState, setSimulatedPrinterState] = useState({}); // printerId -> "testing" | "success"

	useEffect(() => {
		let cancelled = false;

		async function loadJobs() {
			setJobsLoading(true);
			const result = await window.electronAPI.fetchJobs();
			if (!cancelled && result.success) {
				setPrintJobs(result.data.map(transformJob));
			}
			if (!cancelled) setJobsLoading(false);
		}

		loadJobs();

		const unsubscribe = window.electronAPI.onJobsUpdate((jobs) => {
			console.log("[Renderer] jobs:updated received —", jobs.length, "jobs");
			if (!cancelled) {
				setPrintJobs(jobs.map(transformJob));
			}
		});

		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, []);

	const TABS = [
		{ key: "printJobs", label: "Print Jobs", Icon: PrintJobsIcon },
		{ key: "printerManagement", label: "Printers", Icon: PrinterIcon },
		{ key: "history", label: "History", Icon: HistoryIcon },
	];

	const handleTabClick = (tab) => {
		setActiveTab(tab);
		setSelectedEntry(null);
	};

	const getEntries = () => {
		if (activeTab === "printJobs") {
			return printJobs.filter((j) => ACTIVE_STATUSES.has(j.rawStatus));
		} else if (activeTab === "history") {
			const dbHistory = printJobs.filter((j) => !ACTIVE_STATUSES.has(j.rawStatus));
			return [...dbHistory, ...DUMMY_HISTORY];
		} else if (activeTab === "printerManagement") {
			return DUMMY_PRINTERS;
		}
		return [];
	};

	// Simulated Print Action Spooler
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

	const triggerSimulatedDecline = (jobId) => {
		setJobSpoolState((prev) => ({ ...prev, [jobId]: "cancelled" }));
		
		setTimeout(() => {
			setPrintJobs((prevJobs) =>
				prevJobs.map((j) => (j._id === jobId ? { ...j, status: "completed", rawStatus: "cancelled" } : j))
			);
			setSelectedEntry(null);
			setJobSpoolState((prev) => ({ ...prev, [jobId]: null }));
		}, 1500);
	};

	// Simulated printer test page action
	const triggerTestPage = (printerId) => {
		if (simulatedPrinterState[printerId] === "testing") return;

		setSimulatedPrinterState((prev) => ({ ...prev, [printerId]: "testing" }));

		setTimeout(() => {
			setSimulatedPrinterState((prev) => ({ ...prev, [printerId]: "success" }));
			setTimeout(() => {
				setSimulatedPrinterState((prev) => ({ ...prev, [printerId]: null }));
			}, 2500);
		}, 3000);
	};

	return (
		<div className="dashboard">
			<div className="db-body">
				{/* 1. Left sidebar (WhatsApp style narrow vertical navigation) */}
				<nav className="db-sidebar">
					<div className="db-sidebar__top">
						{/* Home / Dashboard Icon at Top (replacing avatar initials) */}
						<div className="tooltip-wrapper">
							<button 
								className={`db-sidebar__home-btn ${activeTab === "dashboard" ? "db-sidebar__home-btn--active" : ""}`}
								onClick={() => handleTabClick("dashboard")}
							>
								<HomeIcon />
							</button>
							<span className="tooltip-text">Dashboard</span>
						</div>

						<div className="db-sidebar__nav">
							{TABS.map(({ key, label, Icon }) => (
								<div key={key} className="tooltip-wrapper">
									<button
										className={`db-tab ${activeTab === key ? "db-tab--active" : ""}`}
										onClick={() => handleTabClick(key)}
									>
										<span className="db-tab__icon">
											<Icon />
										</span>
									</button>
									<span className="tooltip-text">{label}</span>
								</div>
							))}
						</div>
					</div>

					{/* Bottom Settings & Power/Logout Icons */}
					<div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "auto", width: "100%", alignItems: "center" }}>
						{/* Settings Tab Button */}
						<div className="tooltip-wrapper">
							<button 
								className={`db-tab ${activeTab === "settings" ? "db-tab--active" : ""}`}
								onClick={() => handleTabClick("settings")}
							>
								<span className="db-tab__icon">
									<SettingsIcon />
								</span>
							</button>
							<span className="tooltip-text">Settings</span>
						</div>

						{/* Power/Logout Icon */}
						<div className="tooltip-wrapper">
							<button 
								className={`db-tab ${activeTab === "logout" ? "db-tab--active" : ""}`}
								onClick={() => handleTabClick("logout")}
							>
								<span className="db-tab__icon" style={{ color: "var(--color-accent)" }}>
									<LogoutIcon />
								</span>
							</button>
							<span className="tooltip-text">Logout</span>
						</div>
					</div>
				</nav>

				{/* 2. Middle list column (WhatsApp chat list style, persistent app drawer) */}
				{activeTab !== "logout" && (
					<div className="db-list">
						<div className="db-list__header">
							<div className="db-list__title-row">
								<h2 className="db-list__title">
									{activeTab === "dashboard" && "Dashboard"}
									{activeTab === "printJobs" && "Print Jobs"}
									{activeTab === "printerManagement" && "Printers"}
									{activeTab === "history" && "History"}
									{activeTab === "settings" && "Settings"}
								</h2>
								{(activeTab === "printJobs" || activeTab === "history") && (
									<span className="db-list__count">
										{getEntries().length}
									</span>
								)}
							</div>
						</div>

						<div className="db-list__entries">
							{/* Placeholder for settings, logout, and dashboard (to be completed in app drawer) */}
							{(activeTab === "dashboard" || activeTab === "settings") && (
								<div className="db-coming-soon">
									<span className="db-coming-soon__icon">🛠️</span>
									<p style={{ fontWeight: "600", color: "var(--color-text-primary)", fontSize: "14px" }}>To be completed</p>
									<p style={{ fontSize: "11.5px", color: "var(--color-text-secondary)", textAlign: "center", padding: "0 16px", lineHeight: "1.4" }}>
										{activeTab === "dashboard" && "Dashboard analytics and widgets are currently under construction."}
										{activeTab === "settings" && "Settings menu preferences are currently under construction."}
									</p>
								</div>
							)}

							{/* Print Jobs tab entries list */}
							{activeTab === "printJobs" && (
								jobsLoading ? (
									<div className="db-coming-soon">
										<div className="spinner spinner--dark" />
										<p>Loading jobs…</p>
									</div>
								) : getEntries().length === 0 ? (
									<div className="db-coming-soon">
										<p>No active print jobs</p>
									</div>
								) : (
									getEntries().map((entry) => (
										<button
											key={entry._id}
											className={`db-entry ${selectedEntry?._id === entry._id ? "db-entry--active" : ""}`}
											onClick={() => setSelectedEntry(entry)}
										>
											<div className="db-entry__avatar">
												<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
													<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
													<polyline points="14 2 14 8 20 8" />
												</svg>
											</div>
											<div className="db-entry__info">
												<span className="db-entry__name">{entry.fileName}</span>
												<span className="db-entry__meta">
													{entry.copies} copies · {entry.color ? "Color" : "B&W"}
												</span>
											</div>
											<div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "6px" }}>
												<span className="db-entry__time">{entry.time}</span>
												<span className={`db-entry__dot db-entry__dot--${entry.status}`} />
											</div>
										</button>
									))
								)
							)}

							{/* Printers tab list */}
							{activeTab === "printerManagement" && (
								getEntries().map((entry) => (
									<button
										key={entry._id}
										className={`db-entry ${selectedEntry?._id === entry._id ? "db-entry--active" : ""}`}
										onClick={() => setSelectedEntry(entry)}
									>
										<div className="db-entry__avatar" style={{ color: entry.status === "online" ? "var(--color-primary)" : "var(--color-text-muted)" }}>
											<PrinterIcon />
										</div>
										<div className="db-entry__info">
											<span className="db-entry__name">{entry.name}</span>
											<span className="db-entry__meta">{entry.type} · {entry.location}</span>
										</div>
										<div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "6px" }}>
											<span className={`db-status db-status--${entry.status === "online" ? "processing" : "completed"}`} style={{ fontSize: "9px", padding: "2px 6px" }}>
												{entry.status}
											</span>
										</div>
									</button>
								))
							)}

							{/* History tab entries list */}
							{activeTab === "history" && (
								getEntries().length === 0 ? (
									<div className="db-coming-soon">
										<p>No print history</p>
									</div>
								) : (
									getEntries().map((entry) => (
										<button
											key={entry._id}
											className={`db-entry ${selectedEntry?._id === entry._id ? "db-entry--active" : ""}`}
											onClick={() => setSelectedEntry(entry)}
										>
											<div className="db-entry__avatar" style={{ color: "var(--color-text-secondary)" }}>
												<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
													<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
													<polyline points="22 4 12 14.01 9 11.01" />
												</svg>
											</div>
											<div className="db-entry__info">
												<span className="db-entry__name">{entry.fileName}</span>
												<span className="db-entry__meta">Rs. {entry.price} · {entry.copies} copies</span>
											</div>
											<div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
												<span className="db-entry__time">{entry.time}</span>
											</div>
										</button>
									))
								)
							)}
						</div>
					</div>
				)}

				{/* 3. Right detail pane (WhatsApp main chat frame + Sadapay premium billing detail) */}
				<div className="db-detail">
					{selectedEntry ? (
						<div className="db-detail__view">
							{/* JOBS & HISTORY TABS DETAILS PANE */}
							{(activeTab === "printJobs" || activeTab === "history") && (
								<>
									<h3 className="db-detail__title">Document Details</h3>
									
									<div className="receipt-card">
										<div className="receipt-header">
											<h4 className="receipt-title">{selectedEntry.fileName}</h4>
											<span className="receipt-subtitle">
												Job ID: #{selectedEntry._id.slice(-6)} · Received {selectedEntry.time}
											</span>
										</div>
										<div className="receipt-body">
											<div className="receipt-row">
												<span className="receipt-label">Job Status</span>
												<span className={`db-status db-status--${selectedEntry.status}`}>
													{jobSpoolState[selectedEntry._id] === "printing" ? "Spooling..." : selectedEntry.rawStatus || selectedEntry.status}
												</span>
											</div>
											<div className="receipt-row">
												<span className="receipt-label">Total Files</span>
												<span className="receipt-value">{selectedEntry.filesCount} document</span>
											</div>
											<div className="receipt-row">
												<span className="receipt-label">Total Copies</span>
												<span className="receipt-value">{selectedEntry.copies}×</span>
											</div>
											<div className="receipt-row">
												<span className="receipt-label">Printing Mode</span>
												<span className="receipt-value">{selectedEntry.color ? "Color Print" : "Black & White"}</span>
											</div>
											
											{selectedEntry.pageType && (
												<div className="receipt-row">
													<span className="receipt-label">Paper Size</span>
													<span className="receipt-value">{selectedEntry.pageType}</span>
												</div>
											)}
											{selectedEntry.orientation && (
												<div className="receipt-row">
													<span className="receipt-label">Page Orientation</span>
													<span className="receipt-value" style={{ textTransform: "capitalize" }}>{selectedEntry.orientation}</span>
												</div>
											)}
											{selectedEntry.sidedness && (
												<div className="receipt-row">
													<span className="receipt-label">Sides</span>
													<span className="receipt-value">
														{selectedEntry.sidedness === "single" ? "Single-sided" : "Double-sided"}
													</span>
												</div>
											)}
											{selectedEntry.pageSelection && (
												<div className="receipt-row">
													<span className="receipt-label">Page Range</span>
													<span className="receipt-value">{selectedEntry.pageSelection}</span>
												</div>
											)}
											{selectedEntry.note && (
												<div className="receipt-row" style={{ alignItems: "flex-start", marginTop: "4px" }}>
													<span className="receipt-label">User Note</span>
													<span className="receipt-value" style={{ maxWidth: "200px", fontSize: "12px", color: "var(--color-text-secondary)", textAlign: "right", fontStyle: "italic" }}>
														"{selectedEntry.note}"
													</span>
												</div>
											)}

											<div className="receipt-divider" />
											<div className="receipt-row">
												<span className="receipt-total-label">Print Charge</span>
												<span className="receipt-total-value">Rs. {selectedEntry.price}</span>
											</div>
										</div>
									</div>

									{/* Print spooling logs simulation */}
									{jobSpoolState[selectedEntry._id] === "printing" && (
										<div className="printer-status-card" style={{ gap: "10px", padding: "16px", background: "rgba(0, 230, 173, 0.05)", borderColor: "var(--color-primary)" }}>
											<div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
												<div className="spinner spinner--dark" style={{ borderTopColor: "var(--color-primary)" }} />
												<span style={{ fontSize: "13px", fontWeight: "600", color: "var(--primary)" }}>
													Sending file to printer queue...
												</span>
											</div>
											<p style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>
												Spooling 1 file · Rendered 600 DPI graphics · Simulating print spooler
											</p>
										</div>
									)}

									{jobSpoolState[selectedEntry._id] === "success" && (
										<div className="printer-status-card" style={{ gap: "10px", padding: "16px", background: "rgba(0, 230, 173, 0.1)", borderColor: "var(--color-primary)" }}>
											<div style={{ display: "flex", alignItems: "center", gap: "10px", color: "var(--color-primary)" }}>
												<CheckIcon />
												<span style={{ fontSize: "13px", fontWeight: "600" }}>
													Job Printed Successfully!
												</span>
											</div>
										</div>
									)}

									{/* Action buttons panel */}
									{activeTab === "printJobs" && (
										<div className="action-panel">
											{selectedEntry.status !== "completed" ? (
												<>
													<button 
														className="btn-outline btn-outline-danger"
														onClick={() => triggerSimulatedDecline(selectedEntry._id)}
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
											)}
										</div>
									)}
								</>
							)}

							{/* PRINTERS TAB DETAILS PANE */}
							{activeTab === "printerManagement" && (
								<>
									<h3 className="db-detail__title">Printer Configuration</h3>
									
									<div className="printer-status-card">
										<div className="toner-widget">
											<div className="toner-header">
												<span>Ink / Toner cartridges</span>
												<span className="toner-percentage">{selectedEntry.toner}%</span>
											</div>
											<div className="toner-bar">
												<div 
													className="toner-bar-fill" 
													style={{ 
														width: `${selectedEntry.toner}%`,
														background: selectedEntry.toner < 20 ? "var(--color-accent)" : "linear-gradient(90deg, var(--color-primary) 0%, var(--color-primary-light) 100%)"
													}} 
												/>
											</div>
										</div>

										<div className="printer-grid">
											<div className="printer-grid-item">
												<div className="printer-grid-item-icon">
													<IpIcon />
												</div>
												<div className="printer-grid-item-details">
													<span className="printer-grid-item-label">IP Address</span>
													<span className="printer-grid-item-value">{selectedEntry.ipAddress}</span>
												</div>
											</div>
											<div className="printer-grid-item">
												<div className="printer-grid-item-icon">
													<PaperIcon />
												</div>
												<div className="printer-grid-item-details">
													<span className="printer-grid-item-label">Supported Paper</span>
													<span className="printer-grid-item-value">{selectedEntry.paperSize}</span>
												</div>
											</div>
											<div className="printer-grid-item">
												<div className="printer-grid-item-icon">
													<LocIcon />
												</div>
												<div className="printer-grid-item-details">
													<span className="printer-grid-item-label">Physical Location</span>
													<span className="printer-grid-item-value">{selectedEntry.location}</span>
												</div>
											</div>
											<div className="printer-grid-item">
												<div className="printer-grid-item-icon">
													<PrinterIcon />
												</div>
												<div className="printer-grid-item-details">
													<span className="printer-grid-item-label">Hardware Type</span>
													<span className="printer-grid-item-value">{selectedEntry.type}</span>
												</div>
											</div>
										</div>
									</div>

									{/* Print test page spool status */}
									{simulatedPrinterState[selectedEntry._id] === "testing" && (
										<div className="printer-status-card" style={{ gap: "10px", padding: "16px", background: "rgba(0, 230, 173, 0.05)", borderColor: "var(--color-primary)" }}>
											<div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
												<div className="spinner spinner--dark" style={{ borderTopColor: "var(--color-primary)" }} />
												<span style={{ fontSize: "13px", fontWeight: "600", color: "var(--color-primary)" }}>
													Printing test page alignment pattern...
												</span>
											</div>
										</div>
									)}

									{simulatedPrinterState[selectedEntry._id] === "success" && (
										<div className="printer-status-card" style={{ gap: "10px", padding: "16px", background: "rgba(0, 230, 173, 0.1)", borderColor: "var(--color-primary)" }}>
											<div style={{ display: "flex", alignItems: "center", gap: "10px", color: "var(--color-primary)" }}>
												<CheckIcon />
												<span style={{ fontSize: "13px", fontWeight: "600" }}>
													Test page printed! Check paper output.
												</span>
											</div>
										</div>
									)}

									<div className="action-panel">
										<button 
											className="btn-gradient" 
											style={{ width: "100%" }}
											onClick={() => triggerTestPage(selectedEntry._id)}
											disabled={selectedEntry.status !== "online" || simulatedPrinterState[selectedEntry._id] === "testing"}
										>
											{simulatedPrinterState[selectedEntry._id] === "testing" ? (
												<>
													<div className="spinner spinner--dark" style={{ borderTopColor: "#111b21", width: "14px", height: "14px" }} />
													Printing Alignment Page...
												</>
											) : (
												<>
													<PrinterIcon />
													Print Test Page
												</>
											)}
										</button>
									</div>
								</>
							)}
						</div>
					) : (
						/* Render active logout confirmation directly on the right pane */
						activeTab === "logout" ? (
							<div className="db-detail__view">
								<h3 className="db-detail__title">Session Logout</h3>
								<div className="printer-status-card" style={{ gap: "20px", padding: "24px" }}>
									<p style={{ fontSize: "14px", color: "var(--color-text-primary)", lineHeight: "1.5" }}>
										Are you sure you want to end your active ClickPrint session and return to the login screen? This will halt any active spools in this desktop instance.
									</p>
									<div className="action-panel">
										<button 
											className="btn-outline" 
											onClick={() => handleTabClick("printJobs")}
											style={{ flex: 1 }}
										>
											Cancel
										</button>
										<button 
											className="btn-gradient" 
											style={{ 
												flex: 1, 
												background: "linear-gradient(135deg, var(--color-accent) 0%, var(--color-accent-light) 100%)", 
												boxShadow: "var(--shadow-accent)", 
												color: "#ffffff" 
											}}
											onClick={onLogout}
										>
											Confirm Log Out
										</button>
									</div>
								</div>
							</div>
						) : (
							/* WhatsApp style home panel when no item is selected (replaces circular SVG icon with rounded logo) */
							<div className="db-welcome">
								<div className="db-welcome__content">
									<div className="db-welcome__logo-container">
										<img src="icon.png" className="db-welcome__logo-img" alt="ClickPrint Logo" />
									</div>
									<h2 className="db-welcome__title">ClickPrint Desktop</h2>
									<p className="db-welcome__subtitle">
										Manage your print shop jobs instantly. Connect your local printers, view job queues, and print sheets seamlessly. Keep the app open to receive new incoming orders.
									</p>
									<div className="db-welcome__divider" />
									<div className="db-welcome__footer">
										<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
											<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
											<path d="M7 11V7a5 5 0 0 1 10 0v4" />
										</svg>
										End-to-end secure printing channel
									</div>
								</div>
							</div>
						)
					)}
				</div>
			</div>
		</div>
	);
}

export default DashboardScreen;