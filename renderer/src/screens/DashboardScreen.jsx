import React, { useState, useEffect } from "react";

// ── Job helpers ──────────────────────────────────────────────────────────────

// Statuses that belong in the active Print Jobs list vs History
const ACTIVE_STATUSES = new Set(["draft", "submitted", "processing"]);

function mapStatus(serverStatus) {
	if (serverStatus === "draft" || serverStatus === "submitted") return "pending";
	if (serverStatus === "processing") return "processing";
	return "completed"; // completed / cancelled / failed all use the gray dot
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
		fileName: firstFile ? `${firstFile.hash.slice(0, 8)}…` : "Document",
		copies: s.numberOfCopies || 1,
		color: s.color || false,
		status: mapStatus(job.status),
		rawStatus: job.status,
		time: formatTime(job.createdAt),
		// Detailed settings shown in the right-hand panel
		pageType: s.pageType,
		orientation: s.orientation,
		pagesPerSheet: s.pagesPerSheet,
		sidedness: s.sidedness,
		pageSelection: s.pageSelection,
		filesCount: job.files?.length || 0,
	};
}

const DUMMY_HISTORY = [
	{
		_id: "h1",
		customerName: "Fatima Ali",
		fileName: "Notes Bio.pdf",
		pages: 20,
		copies: 1,
		color: false,
		time: "2h ago",
		price: 100,
	},
	{
		_id: "h2",
		customerName: "Zain Malik",
		fileName: "Assignment CS.pdf",
		pages: 8,
		copies: 2,
		color: true,
		time: "5h ago",
		price: 160,
	},
	{
		_id: "h3",
		customerName: "Hira Baig",
		fileName: "Birthday Card.pdf",
		pages: 1,
		copies: 10,
		color: true,
		time: "Yesterday",
		price: 500,
	},
	{
		_id: "h4",
		customerName: "Kamran Shah",
		fileName: "Report Final.pdf",
		pages: 35,
		copies: 1,
		color: false,
		time: "2 days ago",
		price: 175,
	},
];

const ALL_CAPABILITIES = [
	"A4",
	"A3",
	"Color",
	"Black & White",
	"Binding",
	"Scanning",
	"Lamination",
];

// ── Icons ───────────────────────────────────────────────────────────────────

const PrintJobsIcon = () => (
	<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
		<path d="M9 17H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2" />
		<path d="M21 9v11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
		<line x1="11" y1="11" x2="17" y2="11" />
		<line x1="11" y1="15" x2="17" y2="15" />
		<line x1="11" y1="18" x2="14" y2="18" />
	</svg>
);

const PrinterIcon = () => (
	<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
		<polyline points="6 9 6 2 18 2 18 9" />
		<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
		<rect x="6" y="14" width="12" height="8" />
		<circle cx="18" cy="9" r="1" fill="currentColor" />
	</svg>
);

const HistoryIcon = () => (
	<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
		<polyline points="12 8 12 12 14 14" />
		<path d="M3.05 11a9 9 0 1 0 .5-4H4.5" />
		<polyline points="1 7 3 11 7 9" />
	</svg>
);

const SettingsIcon = () => (
	<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
		<circle cx="12" cy="12" r="3" />
		<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
	</svg>
);

const EditIcon = () => (
	<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
		<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
		<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
	</svg>
);

// ── Component ────────────────────────────────────────────────────────────────

function DashboardScreen({ shopProfile, onLogout }) {
	const [activeTab, setActiveTab] = useState(null);
	const [selectedEntry, setSelectedEntry] = useState(null);
	const [showEditModal, setShowEditModal] = useState(false);
	const [shop, setShop] = useState(shopProfile);
	const [editForm, setEditForm] = useState({
		name: shopProfile?.name || "",
		address: shopProfile?.address || "",
		capabilities: shopProfile?.capabilities || [],
	});
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState("");

	// Live job list — populated from GET /api/jobs, kept up-to-date via SSE
	const [printJobs, setPrintJobs] = useState([]);
	const [jobsLoading, setJobsLoading] = useState(true);

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

		// Subscribe to push updates from the main process.
		// The main process reconciles (re-fetches all jobs) on every SSE event
		// and on every SSE reconnect, then sends the full list here.
		const unsubscribe = window.electronAPI.onJobsUpdate((jobs) => {
			console.log("[Renderer] jobs:updated received —", jobs.length, "jobs");
			if (!cancelled) setPrintJobs(jobs.map(transformJob));
		});

		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, []);

	const TABS = [
		{ key: "printJobs", label: "Print Jobs", Icon: PrintJobsIcon },
		{ key: "printerManagement", label: "Printer Management", Icon: PrinterIcon },
		{ key: "history", label: "History", Icon: HistoryIcon },
		{ key: "settings", label: "Settings", Icon: SettingsIcon },
	];

	const handleTabClick = (tab) => {
		if (activeTab === tab) {
			setActiveTab(null);
			setSelectedEntry(null);
		} else {
			setActiveTab(tab);
			setSelectedEntry(null);
		}
	};

	const getEntries = () => {
		if (activeTab === "printJobs")
			return printJobs.filter((j) => ACTIVE_STATUSES.has(j.rawStatus));
		if (activeTab === "history")
			return [...printJobs.filter((j) => !ACTIVE_STATUSES.has(j.rawStatus)), ...DUMMY_HISTORY];
		return [];
	};

	const openEditModal = () => {
		setEditForm({
			name: shop?.name || "",
			address: shop?.address || "",
			capabilities: [...(shop?.capabilities || [])],
		});
		setSaveError("");
		setShowEditModal(true);
	};

	const toggleCapability = (cap) => {
		setEditForm((prev) => ({
			...prev,
			capabilities: prev.capabilities.includes(cap)
				? prev.capabilities.filter((c) => c !== cap)
				: [...prev.capabilities, cap],
		}));
	};

	const handleSaveShop = async () => {
		if (!editForm.name.trim() || !editForm.address.trim()) {
			setSaveError("Name and address are required.");
			return;
		}
		setSaving(true);
		setSaveError("");
		try {
			const result = await window.electronAPI.updateShop(shop._id, {
				name: editForm.name.trim(),
				address: editForm.address.trim(),
				capabilities: editForm.capabilities,
			});
			if (result.success) {
				setShop(result.data.shop);
				setShowEditModal(false);
			} else {
				setSaveError(result.message || "Failed to save changes.");
			}
		} catch {
			setSaveError("An unexpected error occurred.");
		} finally {
			setSaving(false);
		}
	};

	const tabLabel = {
		printJobs: "Print Jobs",
		printerManagement: "Printer Management",
		history: "History",
		settings: "Settings",
	};

	const isListTab = activeTab === "printJobs" || activeTab === "history";

	return (
		<div className="dashboard">
			{/* ── Content header ── */}
			{/* <header className="db-header">
				<div className="db-header__shop">
					<span className="db-shop-name">{shop?.name}</span>
					<button
						className="db-edit-btn"
						onClick={openEditModal}
						title="Edit shop details"
					>
						<EditIcon />
					</button>
				</div>
				<div className="db-header__right">
					<span className="db-greeting">
						Hi, <strong>{shop?.name?.split(" ")[0]}</strong>
					</span>
					<button className="db-logout-btn" onClick={onLogout}>
						Logout
					</button>
				</div>
			</header> */}

			{/* ── 3-column body ── */}
			<div className="db-body">
				{/* Left sidebar: icon tabs */}
				<nav className="db-sidebar">
					{TABS.map(({ key, label, Icon }) => (
						<button
							key={key}
							className={`db-tab ${activeTab === key ? "db-tab--active" : ""}`}
							onClick={() => handleTabClick(key)}
							title={label}
						>
							<span className="db-tab__icon">
								<Icon />
							</span>
							<span className="db-tab__label">{label}</span>
						</button>
					))}
				</nav>

				{/* Middle: entry list (slides in when a tab is active) */}
				<div
					className={`db-list ${activeTab ? "db-list--visible" : ""}`}
				>
					{activeTab && (
						<>
							<div className="db-list__header">
								<h2 className="db-list__title">
									{tabLabel[activeTab]}
								</h2>
								{isListTab && (
									<span className="db-list__count">
										{getEntries().length}
									</span>
								)}
							</div>

							<div className="db-list__entries">
								{isListTab ? (
									jobsLoading && activeTab === "printJobs" ? (
										<div className="db-coming-soon">
											<div className="spinner" />
											<p>Loading jobs…</p>
										</div>
									) : getEntries().length === 0 ? (
										<div className="db-coming-soon">
											<p>No entries</p>
										</div>
									) : (
										getEntries().map((entry) => (
											<button
												key={entry._id}
												className={`db-entry ${selectedEntry?._id === entry._id ? "db-entry--active" : ""}`}
												onClick={() =>
													setSelectedEntry(entry)
												}
											>
												<span
													className={`db-entry__dot db-entry__dot--${entry.status || "completed"}`}
												/>
												<div className="db-entry__info">
													<span className="db-entry__name">
														{entry.fileName}
													</span>
													<span className="db-entry__meta">
														{entry.copies}×
														{entry.color ? " · Color" : " · B&W"}
														{entry.filesCount > 1 ? ` · ${entry.filesCount} files` : ""}
													</span>
												</div>
												<span className="db-entry__time">
													{entry.time}
												</span>
											</button>
										))
									)
								) : (
									<div className="db-coming-soon">
										<span className="db-coming-soon__icon">
											🚧
										</span>
										<p>Coming soon</p>
									</div>
								)}
							</div>
						</>
					)}
				</div>

				{/* Right: detail panel */}
				<div className="db-detail">
					{selectedEntry ? (
						<div className="db-detail__view">
							<h3 className="db-detail__title">
								{selectedEntry.fileName}
							</h3>
							<div className="db-detail__fields">
								<DetailField
									label="Copies"
									value={selectedEntry.copies}
								/>
								<DetailField
									label="Color"
									value={
										selectedEntry.color
											? "Color"
											: "Black & White"
									}
								/>
								{selectedEntry.status && (
									<div className="db-field">
										<span className="db-field__label">
											Status
										</span>
										<span
											className={`db-field__value db-status db-status--${selectedEntry.status}`}
										>
											{(selectedEntry.rawStatus || selectedEntry.status)
												.charAt(0)
												.toUpperCase() +
												(selectedEntry.rawStatus || selectedEntry.status).slice(1)}
										</span>
									</div>
								)}
								{selectedEntry.pageType && (
									<DetailField
										label="Page Type"
										value={selectedEntry.pageType}
									/>
								)}
								{selectedEntry.orientation && (
									<DetailField
										label="Orientation"
										value={selectedEntry.orientation
											.charAt(0).toUpperCase() +
											selectedEntry.orientation.slice(1)}
									/>
								)}
								{selectedEntry.pagesPerSheet > 1 && (
									<DetailField
										label="Per Sheet"
										value={`${selectedEntry.pagesPerSheet} pages`}
									/>
								)}
								{selectedEntry.sidedness && (
									<DetailField
										label="Sides"
										value={selectedEntry.sidedness === "single"
											? "Single-sided"
											: selectedEntry.sidedness === "long"
											? "Double-sided (long edge)"
											: selectedEntry.sidedness === "short"
											? "Double-sided (short edge)"
											: selectedEntry.sidedness}
									/>
								)}
								{selectedEntry.pageSelection && (
									<DetailField
										label="Pages"
										value={selectedEntry.pageSelection}
									/>
								)}
								{selectedEntry.filesCount > 1 && (
									<DetailField
										label="Files"
										value={selectedEntry.filesCount}
									/>
								)}
								{selectedEntry.price !== undefined && (
									<DetailField
										label="Price"
										value={`Rs. ${selectedEntry.price}`}
									/>
								)}
								{selectedEntry.note && (
									<DetailField
										label="Note"
										value={selectedEntry.note}
									/>
								)}
							</div>
						</div>
					) : (
						<div className="db-detail__welcome">
							<div className="db-detail__logo">
								<img src="icon.png" className="db-detail__logo-img" alt="ClickPrint" />
							</div>
							<p className="db-detail__msg">
								{activeTab
									? "Select an entry to view details"
									: "Choose a section from the left"}
							</p>
						</div>
					)}
				</div>
			</div>

			{/* ── Edit Shop Modal ── */}
			{showEditModal && (
				<div
					className="modal-overlay modal-overlay--center"
					onClick={(e) => {
						if (e.target === e.currentTarget)
							setShowEditModal(false);
					}}
				>
					<div className="edit-modal">
						<h3 className="edit-modal__title">Edit Shop Details</h3>

						<div className="edit-field">
							<label className="edit-field__label">
								Shop Name
							</label>
							<input
								className="edit-field__input"
								type="text"
								value={editForm.name}
								onChange={(e) =>
									setEditForm((p) => ({
										...p,
										name: e.target.value,
									}))
								}
								placeholder="Enter shop name"
							/>
						</div>

						<div className="edit-field">
							<label className="edit-field__label">Address</label>
							<input
								className="edit-field__input"
								type="text"
								value={editForm.address}
								onChange={(e) =>
									setEditForm((p) => ({
										...p,
										address: e.target.value,
									}))
								}
								placeholder="Enter address"
							/>
						</div>

						<div className="edit-field">
							<label className="edit-field__label">
								Capabilities
							</label>
							<div className="capability-tags">
								{ALL_CAPABILITIES.map((cap) => (
									<button
										key={cap}
										type="button"
										className={`capability-tag ${editForm.capabilities.includes(cap) ? "capability-tag--active" : ""}`}
										onClick={() => toggleCapability(cap)}
									>
										{cap}
									</button>
								))}
							</div>
						</div>

						{saveError && (
							<p className="edit-modal__error">{saveError}</p>
						)}

						<div className="edit-modal__actions">
							<button
								className="modal-btn--cancel"
								onClick={() => setShowEditModal(false)}
								disabled={saving}
							>
								Cancel <span>✕</span>
							</button>
							<button
								className="modal-btn--retry"
								onClick={handleSaveShop}
								disabled={saving}
							>
								{saving ? (
									<div className="spinner" />
								) : (
									<>
										Save <span>→</span>
									</>
								)}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

function DetailField({ label, value }) {
	return (
		<div className="db-field">
			<span className="db-field__label">{label}</span>
			<span className="db-field__value">{value}</span>
		</div>
	);
}

export default DashboardScreen;
