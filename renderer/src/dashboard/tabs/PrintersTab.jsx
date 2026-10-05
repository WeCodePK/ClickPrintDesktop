import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import ListColumn from "../components/ListColumn";
import WelcomePane from "../components/WelcomePane";
import EmptyState from "../components/EmptyState";
import StaleNote from "../components/StaleNote";
import { useNetStatus, OFFLINE_ACTION_HINT } from "../useNetStatus";
import ConfirmDialog from "../components/ConfirmDialog";
import { useAutoPrint } from "../AutoPrintContext";
import { PrinterIcon, CheckIcon, TrashIcon } from "../icons";

// How often the tab re-checks which registered printers are still reachable.
const ONLINE_POLL_MS = 15000;

const DUPLEX_LABELS = {
	OneSided: "Single-sided",
	TwoSidedLongEdge: "Double-sided (long edge)",
	TwoSidedShortEdge: "Double-sided (short edge)",
};

// The detail page's groups of rows, from the app's own state and what Windows
// reports (`d`, from printers:details). Rows without a value are left out, and
// so is a group left with none.
function printerFacts(entry, d) {
	const status = entry.isDisabled ? "Disabled" : entry.online ? "Ready" : "Offline";
	const address = d.hostAddress ? `${d.hostAddress}${d.portNumber ? `:${d.portNumber}` : ""}` : null;
	const resolution =
		d.horizontalResolution && d.verticalResolution ? `${d.horizontalResolution} × ${d.verticalResolution} dpi` : null;
	const groups = [
		{
			title: "Status",
			rows: [
				["Status", status],
				["Windows status", d.printerStatus],
				["Jobs in queue", d.jobCount != null ? String(d.jobCount) : null],
				["System default", d.isDefault == null ? null : d.isDefault ? "Yes" : "No"],
			],
		},
		{
			title: "Connection",
			rows: [
				["Connection", d.type === "Connection" ? "Network (shared printer)" : d.type],
				["Port", d.portName],
				["Port type", d.portDescription],
				["Address", address],
				["Shared as", d.shared ? d.shareName : null],
				["Location", d.location],
				["Comment", d.comment],
			],
		},
		{
			title: "Driver",
			rows: [
				["Driver", d.driverName],
				["Manufacturer", d.driverManufacturer],
				["Version", d.driverVersion],
			],
		},
		{
			title: "Defaults",
			rows: [
				["Colour", d.color == null ? null : d.color ? "Colour" : "Black & white"],
				["Sides", DUPLEX_LABELS[d.duplexingMode] || d.duplexingMode],
				["Paper size", d.paperSize],
				["Resolution", resolution],
			],
		},
	];
	return groups
		.map((g) => ({ ...g, rows: g.rows.filter(([, value]) => value != null && value !== "") }))
		.filter((g) => g.rows.length > 0);
}

// Printers settings section: the shop's registered printers (GET /api/printers),
// each shown with its live online/offline state. Adding opens a picker of the
// machine's currently-online printers; removing deletes it from the backend.
function PrintersTab() {
	const { refreshPrinterState } = useAutoPrint();

	const [registered, setRegistered] = useState([]); // backend printers: { _id, name }
	const [online, setOnline] = useState([]); // live local printers (online only)
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(null);
	// { stale, fetchedAt } — set when the list is the copy saved before the
	// connection dropped.
	const [saved, setSaved] = useState({ stale: false, fetchedAt: null });
	// The backend's reachability (`online` above is the local printers').
	const net = useNetStatus();
	const offline = !net.online;
	const [selectedId, setSelectedId] = useState(null);
	const [testState, setTestState] = useState({}); // name -> "testing" | "success" | "error"
	const [confirmDelete, setConfirmDelete] = useState(null);
	const [togglingId, setTogglingId] = useState(null); // printer whose enable/disable is in flight

	// Add-printer picker
	const [addOpen, setAddOpen] = useState(false);
	const [addLoading, setAddLoading] = useState(false);
	const [addChoices, setAddChoices] = useState([]);
	const [addSelected, setAddSelected] = useState([]); // names
	const [addSaving, setAddSaving] = useState(false);
	const [addError, setAddError] = useState(null);

	const loadRegistered = useCallback(async () => {
		try {
			const result = await window.electronAPI.fetchPrinters();
			if (result?.success) {
				setRegistered(result.data || []);
				setSaved({ stale: !!result.stale, fetchedAt: result.fetchedAt || null });
				setError(null);
			} else setError(result?.message || "Failed to load printers.");
		} catch (err) {
			console.error("[Renderer] failed to load printers:", err);
			setError("Failed to load printers.");
		}
	}, []);

	const loadOnline = useCallback(async (force = false) => {
		try {
			const result = await window.electronAPI.listPrinters(force);
			if (result?.success) setOnline(result.data || []);
		} catch (err) {
			console.error("[Renderer] failed to list local printers:", err);
		}
	}, []);

	useEffect(() => {
		(async () => {
			setLoading(true);
			setError(null);
			await Promise.all([loadRegistered(), loadOnline()]);
			setLoading(false);
		})();
	}, [loadRegistered, loadOnline]);

	// Back online: replace a saved (or missing) list with the real one.
	useEffect(() => {
		if (net.online && (saved.stale || error)) loadRegistered();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [net.online]);

	// Periodically re-check reachability so an entry greys out when its printer
	// drops off (the entry itself is never removed).
	useEffect(() => {
		const id = setInterval(() => loadOnline(), ONLINE_POLL_MS);
		return () => clearInterval(id);
	}, [loadOnline]);

	// Merge the registered list with live reachability.
	const onlineByName = new Map(online.map((p) => [p.name, p]));
	const entries = registered.map((p) => {
		const local = onlineByName.get(p.name) || null;
		return { ...p, online: !!local, local };
	});
	const selectedEntry = entries.find((e) => e._id === selectedId) || null;
	const selectedName = selectedEntry?.name || null;

	// What Windows reports about the selected printer: { name, data } once loaded
	// (data null = not installed here). Keyed by name so a quick switch never
	// shows the previous printer's details.
	const [details, setDetails] = useState(null);
	useEffect(() => {
		if (!selectedName) return;
		let active = true;
		setDetails(null);
		window.electronAPI
			.getPrinterDetails(selectedName)
			.then((result) => active && setDetails({ name: selectedName, data: result?.data ?? null }))
			.catch((err) => {
				console.error("[Renderer] failed to load printer details:", err);
				if (active) setDetails({ name: selectedName, data: null });
			});
		return () => {
			active = false;
		};
	}, [selectedName]);
	const selectedDetails = details?.name === selectedName ? details : null;

	// The picker lists every installed printer, plus any registered printer that
	// isn't installed on this machine — so it can still be unticked to remove it.
	const installedNames = new Set(addChoices.map((p) => p.name));
	const pickChoices = [
		...addChoices,
		...registered
			.filter((p) => !installedNames.has(p.name))
			.map((p) => ({ name: p.name, displayName: p.name, notInstalled: true })),
	];
	const toAdd = addSelected.filter((name) => !registered.some((p) => p.name === name));
	const toRemove = registered.filter((p) => !addSelected.includes(p.name));
	const pickChanged = toAdd.length > 0 || toRemove.length > 0;

	// ── Add / remove printers ──────────────────────────────────────────────────
	const openAdd = async () => {
		setAddOpen(true);
		// Start from the shop's current printers, ticked.
		setAddSelected(registered.map((p) => p.name));
		setAddError(null);
		setAddLoading(true);
		try {
			// Fetch ALL installed printers (online + offline) so the operator
			// can register a printer even when it's temporarily powered off.
			const result = await window.electronAPI.listAllPrinters(true);
			if (result?.success) {
				setAddChoices(result.data || []);
			} else {
				setAddError(result?.message || "Failed to find printers.");
			}
		} catch (err) {
			console.error("[Renderer] failed to find printers:", err);
			setAddError("Failed to find printers.");
		} finally {
			setAddLoading(false);
		}
	};

	const toggleChoice = (name) =>
		setAddSelected((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));

	// Ticked printers that aren't registered yet are added; registered printers
	// that were unticked are removed.
	const confirmAdd = async () => {
		if (!pickChanged) return;
		setAddSaving(true);
		setAddError(null);
		try {
			for (const name of toAdd) {
				const result = await window.electronAPI.createPrinter(name);
				if (!result?.success) throw new Error(result?.message || `Couldn't add “${name}”.`);
			}
			for (const printer of toRemove) {
				const result = await window.electronAPI.deletePrinter(printer._id);
				if (!result?.success) throw new Error(result?.message || `Couldn't remove “${printer.name}”.`);
				if (selectedId === printer._id) setSelectedId(null);
			}
			setAddOpen(false);
		} catch (err) {
			console.error("[Renderer] failed to save printers:", err);
			setAddError(err.message || "Failed to save printers.");
		} finally {
			// Reflect whatever did go through, even after a partial failure.
			await loadRegistered();
			if (toRemove.length) refreshPrinterState(); // services may have routed to these
			setAddSaving(false);
		}
	};

	// ── Remove printer ─────────────────────────────────────────────────────────
	const handleDelete = async (printer) => {
		setConfirmDelete(null);
		try {
			const result = await window.electronAPI.deletePrinter(printer._id);
			if (!result?.success) throw new Error(result?.message || "delete failed");
			if (selectedId === printer._id) setSelectedId(null);
			await loadRegistered();
			refreshPrinterState(); // services may have routed to this printer
		} catch (err) {
			console.error("[Renderer] failed to remove printer:", err);
		}
	};

	// ── Enable / disable ───────────────────────────────────────────────────────
	const handleToggleDisabled = async (entry) => {
		if (togglingId) return;
		setTogglingId(entry._id);
		try {
			const result = await window.electronAPI.setPrinterDisabled(entry._id, !entry.isDisabled);
			if (!result?.success) throw new Error(result?.message || "update failed");
			// Prefer the server's returned printer; fall back to flipping locally.
			const updated = result.data && result.data._id ? result.data : { ...entry, isDisabled: !entry.isDisabled };
			setRegistered((prev) => prev.map((p) => (p._id === entry._id ? { ...p, ...updated } : p)));
			refreshPrinterState(); // disabling affects service routing + the auto-print gate
		} catch (err) {
			console.error("[Renderer] failed to toggle printer disabled state:", err);
		} finally {
			setTogglingId(null);
		}
	};

	// ── Test / select ──────────────────────────────────────────────────────────
	const handleTest = async (entry) => {
		if (testState[entry.name] === "testing") return;
		setTestState((prev) => ({ ...prev, [entry.name]: "testing" }));
		try {
			const result = await window.electronAPI.testPrinter(entry.name);
			if (!result?.success) throw new Error(result?.message || "test failed");
			setTestState((prev) => ({ ...prev, [entry.name]: "success" }));
		} catch (err) {
			console.error("[Renderer] test print failed:", err);
			setTestState((prev) => ({ ...prev, [entry.name]: "error" }));
		}
		setTimeout(() => setTestState((prev) => ({ ...prev, [entry.name]: null })), 3500);
	};

	return (
		<>
			<ListColumn
				title="Printers"
				bodyClassName="db-list__entries--column"
				action={
					<button
						className="db-list__add"
						onClick={openAdd}
						disabled={offline}
						title={offline ? OFFLINE_ACTION_HINT : "Add printers"}
					>
						+ Add
					</button>
				}
			>
				<StaleNote stale={saved.stale} fetchedAt={saved.fetchedAt} />
				{loading ? (
					<div className="db-coming-soon">
						<div className="spinner spinner--dark" />
						<p>Loading printers…</p>
					</div>
				) : error && registered.length === 0 ? (
					<div className="db-coming-soon">
						<p>{offline ? "You're offline — your printers will appear once the connection is back." : error}</p>
						<button type="button" className="btn-outline btn-sm" onClick={loadRegistered}>
							Try again
						</button>
					</div>
				) : entries.length === 0 ? (
					<EmptyState art="printer" title="No printers added" />
				) : (
					entries.map((entry) => (
						<div
							key={entry._id}
							className={`db-entry ${selectedId === entry._id ? "db-entry--active" : ""} ${entry.online && !entry.isDisabled ? "" : "db-entry--offline"}`}
							role="button"
							tabIndex={0}
							onClick={() => setSelectedId(entry._id)}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									setSelectedId(entry._id);
								}
							}}
						>
							<div className={`db-entry__avatar ${entry.online && !entry.isDisabled ? "db-entry__avatar--chosen" : "db-entry__avatar--muted"}`}>
								<PrinterIcon />
							</div>
							<div className="db-entry__info">
								<span className="db-entry__name">{entry.local?.displayName || entry.name}</span>
								<span className="db-entry__meta">
									{entry.isDisabled
										? "Disabled"
										: entry.online
											? "Ready"
											: "Offline"}
								</span>
							</div>
						</div>
					))
				)}
			</ListColumn>

			<div className="db-detail">
				{selectedEntry ? (
					<div className="db-detail__view">
						<div className="db-detail__titlebar">
							<h3 className="db-detail__title">{selectedEntry.local?.displayName || selectedEntry.name}</h3>
							<div className="db-detail__titlebar-actions">
								<button
									type="button"
									className="btn-outline"
									onClick={() => handleTest(selectedEntry)}
									disabled={!selectedEntry.online || testState[selectedEntry.name] === "testing"}
								>
									{testState[selectedEntry.name] === "testing" ? (
										<>
											<div className="spinner spinner--dark" style={{ borderTopColor: "var(--color-primary)", width: "13px", height: "13px" }} />
											Printing…
										</>
									) : (
										<>
											<PrinterIcon />
											Print Test Page
										</>
									)}
								</button>
								<button
									type="button"
									className="btn-outline db-detail__remove"
									onClick={() => setConfirmDelete(selectedEntry)}
									disabled={offline}
									title={offline ? OFFLINE_ACTION_HINT : undefined}
								>
									<TrashIcon />
									Delete
								</button>
								<button
									type="button"
									className={`toggle ${selectedEntry.isDisabled ? "" : "toggle--on"}`}
									role="switch"
									aria-checked={!selectedEntry.isDisabled}
									title={selectedEntry.isDisabled ? "Enable this printer" : "Disable this printer"}
									disabled={togglingId === selectedEntry._id || offline}
									title={offline ? OFFLINE_ACTION_HINT : undefined}
									onClick={() => handleToggleDisabled(selectedEntry)}
								>
									<span className="toggle__knob" />
								</button>
							</div>
						</div>

						{/* Status messages, above the details. */}
						<div className="printer-alerts">
							{selectedEntry.isDisabled && (
								<div className="printer-status-card" style={{ gap: "10px", padding: "16px", background: "rgba(134, 150, 160, 0.08)", borderColor: "var(--border-light)" }}>
									<span style={{ fontSize: "13px", fontWeight: "600", color: "var(--color-text-secondary)" }}>
										This printer is disabled.
									</span>
								</div>
							)}

							{!selectedEntry.online && (
								<div className="printer-status-card" style={{ gap: "10px", padding: "16px", background: "rgba(255, 87, 10, 0.08)", borderColor: "var(--color-accent)" }}>
									<span style={{ fontSize: "13px", fontWeight: "600", color: "var(--color-accent)" }}>
										This printer is offline. Turn it on or reconnect it to print.
									</span>
								</div>
							)}

							{testState[selectedEntry.name] === "testing" && (
								<div className="printer-status-card" style={{ gap: "10px", padding: "16px", background: "rgba(0, 230, 173, 0.05)", borderColor: "var(--color-primary)" }}>
									<div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
										<div className="spinner spinner--dark" style={{ borderTopColor: "var(--color-primary)" }} />
										<span style={{ fontSize: "13px", fontWeight: "600", color: "var(--color-primary)" }}>
											Sending test page to {selectedEntry.local?.displayName || selectedEntry.name}…
										</span>
									</div>
								</div>
							)}
							{testState[selectedEntry.name] === "success" && (
								<div className="printer-status-card" style={{ gap: "10px", padding: "16px", background: "rgba(0, 230, 173, 0.1)", borderColor: "var(--color-primary)" }}>
									<div style={{ display: "flex", alignItems: "center", gap: "10px", color: "var(--color-primary)" }}>
										<CheckIcon />
										<span style={{ fontSize: "13px", fontWeight: "600" }}>Test page sent! Check the paper output.</span>
									</div>
								</div>
							)}
							{testState[selectedEntry.name] === "error" && (
								<div className="printer-status-card" style={{ gap: "10px", padding: "16px", background: "rgba(255, 87, 10, 0.08)", borderColor: "var(--color-accent)" }}>
									<span style={{ fontSize: "13px", fontWeight: "600", color: "var(--color-accent)" }}>
										Couldn't print the test page. Check that the printer is on and connected.
									</span>
								</div>
							)}
						</div>

						{/* What Windows reports about this printer. */}
						{!selectedDetails ? (
							<p className="printer-facts__note">
								<span className="spinner spinner--dark" style={{ borderTopColor: "var(--color-primary)", width: "14px", height: "14px" }} />
								Reading printer details…
							</p>
						) : !selectedDetails.data ? (
							<p className="printer-facts__note">
								This printer isn't installed on this PC, so Windows has no details for it.
							</p>
						) : (
							<div className="printer-facts">
								{printerFacts(selectedEntry, selectedDetails.data).map((group) => (
									<section key={group.title} className="printer-facts__group">
										<h4 className="printer-facts__title">{group.title}</h4>
										<dl className="printer-facts__list">
											{group.rows.map(([label, value]) => (
												<div key={label} className="printer-facts__row">
													<dt>{label}</dt>
													<dd>{value}</dd>
												</div>
											))}
										</dl>
									</section>
								))}
							</div>
						)}

					</div>
				) : (
					<WelcomePane />
				)}
			</div>

			{addOpen && createPortal(
				<div className="modal-overlay" onClick={() => !addSaving && setAddOpen(false)}>
					<div className="modal-card modal-card--wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
						<h3 className="modal-title">Add printers</h3>
						<p className="modal-message">
							Pick the printers you want to add to this shop.
						</p>
						<div className="modal-divider" />

						{addError && <div className="form-error">{addError}</div>}

						{addLoading ? (
							<div className="db-coming-soon">
								<div className="spinner spinner--dark" />
								<p>Finding printers…</p>
							</div>
						) : pickChoices.length === 0 ? (
							<div className="db-detail__empty">
								<p>No printers found. Install a printer on this machine and try again.</p>
							</div>
						) : (
							<div className="printer-pick-list">
								{pickChoices.map((p) => {
									const checked = addSelected.includes(p.name);
									return (
										<button
											type="button"
											key={p.name}
											className={`printer-pick ${checked ? "printer-pick--on" : ""}`}
											onClick={() => toggleChoice(p.name)}
										>
											<span className="printer-pick__check">{checked && <CheckIcon />}</span>
											<span className="printer-pick__info">
												<span className="printer-pick__name">{p.displayName}</span>
												<span className="printer-pick__meta">
													{p.notInstalled
														? "Not installed on this PC"
														: p.offline
															? "Offline"
															: "Ready"}
												</span>
											</span>
										</button>
									);
								})}
							</div>
						)}

						<div className="action-panel">
							<button className="btn-outline" onClick={() => setAddOpen(false)} disabled={addSaving}>
								Cancel
							</button>
							<button
								className="btn-gradient"
								onClick={confirmAdd}
								disabled={addSaving || !pickChanged || offline}
							>
								{addSaving ? "Adding…" : "Add"}
							</button>
						</div>
					</div>
				</div>,
				document.body
			)}

			{confirmDelete && createPortal(
				<ConfirmDialog
					title={`Delete ${confirmDelete.local?.displayName || confirmDelete.name}?`}
					message="Are you sure you want to delete this printer?"
					confirmLabel="Delete"
					cancelLabel="Cancel"
					danger
					onConfirm={() => handleDelete(confirmDelete)}
					onCancel={() => setConfirmDelete(null)}
				/>,
				document.body
			)}
		</>
	);
}

export default PrintersTab;
