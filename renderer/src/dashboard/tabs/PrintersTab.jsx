import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import ListColumn from "../components/ListColumn";
import WelcomePane from "../components/WelcomePane";
import ConfirmDialog from "../components/ConfirmDialog";
import { useAutoPrint } from "../AutoPrintContext";
import { PrinterIcon, PaperIcon, CheckIcon, RefreshIcon, TrashIcon } from "../icons";

// How often the tab re-checks which registered printers are still reachable.
const ONLINE_POLL_MS = 15000;

// Printers tab: the shop's registered printers (GET /api/printers), each shown
// with its live online/offline state. Adding opens a picker of the machine's
// currently-online printers; removing deletes it from the backend.
function PrintersTab() {
	const { refreshPrinterState } = useAutoPrint();

	const [registered, setRegistered] = useState([]); // backend printers: { _id, name }
	const [online, setOnline] = useState([]); // live local printers (online only)
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(null);
	const [selectedId, setSelectedId] = useState(null);
	const [chosen, setChosen] = useState(null); // app's saved default printer name
	const [testState, setTestState] = useState({}); // name -> "testing" | "success" | "error"
	const [saving, setSaving] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(null);

	// Add-printer picker
	const [addOpen, setAddOpen] = useState(false);
	const [addLoading, setAddLoading] = useState(false);
	const [addChoices, setAddChoices] = useState([]);
	const [addSelected, setAddSelected] = useState([]); // names
	const [addSaving, setAddSaving] = useState(false);
	const [addError, setAddError] = useState(null);

	const loadRegistered = useCallback(async () => {
		try {
			const [result, selected] = await Promise.all([
				window.electronAPI.fetchPrinters(),
				window.electronAPI.getSelectedPrinter(),
			]);
			if (result?.success) setRegistered(result.data || []);
			else setError(result?.message || "Failed to load printers.");
			setChosen(selected?.name || null);
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

	const registeredNames = new Set(registered.map((p) => p.name));
	const availableChoices = addChoices.filter((p) => !registeredNames.has(p.name));

	// ── Add printer ────────────────────────────────────────────────────────────
	const openAdd = async () => {
		setAddOpen(true);
		setAddSelected([]);
		setAddError(null);
		setAddLoading(true);
		try {
			// Force a fresh PowerShell/WMI query so the list is current.
			const result = await window.electronAPI.listPrinters(true);
			if (result?.success) {
				setOnline(result.data || []);
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

	const confirmAdd = async () => {
		if (addSelected.length === 0) return;
		setAddSaving(true);
		setAddError(null);
		try {
			for (const name of addSelected) {
				const result = await window.electronAPI.createPrinter(name);
				if (!result?.success) throw new Error(result?.message || `Couldn't add “${name}”.`);
			}
			await loadRegistered();
			setAddOpen(false);
		} catch (err) {
			console.error("[Renderer] failed to add printer(s):", err);
			setAddError(err.message || "Failed to add printer(s).");
		} finally {
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
			// If it was the app's default, clear that too so nothing points at it.
			if (chosen === printer.name) {
				await window.electronAPI.setSelectedPrinter(null);
				setChosen(null);
				refreshPrinterState();
			}
			await loadRegistered();
		} catch (err) {
			console.error("[Renderer] failed to remove printer:", err);
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

	const handleSelect = async (entry) => {
		setSaving(true);
		try {
			const result = await window.electronAPI.setSelectedPrinter({
				name: entry.name,
				displayName: entry.local?.displayName || entry.name,
			});
			if (!result?.success) throw new Error(result?.message || "save failed");
			setChosen(entry.name);
			refreshPrinterState(); // propagate the new default to the dashboard/auto-print
		} catch (err) {
			console.error("[Renderer] failed to save selected printer:", err);
		} finally {
			setSaving(false);
		}
	};

	return (
		<>
			<ListColumn
				title="Printers"
				count={entries.length}
				action={
					<button className="db-list__add" onClick={openAdd} title="Add a printer">
						+ Add
					</button>
				}
			>
				{loading ? (
					<div className="db-coming-soon">
						<div className="spinner spinner--dark" />
						<p>Loading printers…</p>
					</div>
				) : error ? (
					<div className="db-coming-soon">
						<p>{error}</p>
					</div>
				) : entries.length === 0 ? (
					<div className="db-coming-soon">
						<p>No printers added</p>
						<p style={{ fontSize: "11.5px", color: "var(--color-text-secondary)" }}>
							Use “+ Add” to register a connected printer.
						</p>
					</div>
				) : (
					entries.map((entry) => (
						<div
							key={entry._id}
							className={`db-entry ${selectedId === entry._id ? "db-entry--active" : ""} ${entry.online ? "" : "db-entry--offline"}`}
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
							<div className={`db-entry__avatar ${chosen === entry.name ? "db-entry__avatar--chosen" : "db-entry__avatar--muted"}`}>
								<PrinterIcon />
							</div>
							<div className="db-entry__info">
								<span className="db-entry__name">{entry.local?.displayName || entry.name}</span>
								<span className="db-entry__meta">
									{entry.online
										? `Ready${entry.local?.isDefault ? " · System default" : ""}`
										: "Offline"}
								</span>
							</div>
							<div className="db-entry__price-actions">
								{chosen === entry.name && (
									<span className="db-status db-status--processing" style={{ fontSize: "9px", padding: "2px 6px" }}>
										Selected
									</span>
								)}
								<button
									type="button"
									className="db-entry__delete-btn db-entry__delete-btn--accent"
									title="Remove this printer"
									onClick={(e) => {
										e.stopPropagation();
										setConfirmDelete(entry);
									}}
								>
									<TrashIcon />
								</button>
							</div>
						</div>
					))
				)}
			</ListColumn>

			<div className="db-detail">
				{selectedEntry ? (
					<div className="db-detail__view">
						<h3 className="db-detail__title">Printer Configuration</h3>

						<div className="printer-status-card">
							<div className="printer-grid">
								<div className="printer-grid-item">
									<div className="printer-grid-item-icon"><PrinterIcon /></div>
									<div className="printer-grid-item-details">
										<span className="printer-grid-item-label">Printer</span>
										<span className="printer-grid-item-value">{selectedEntry.local?.displayName || selectedEntry.name}</span>
									</div>
								</div>
								<div className="printer-grid-item">
									<div className="printer-grid-item-icon"><CheckIcon /></div>
									<div className="printer-grid-item-details">
										<span className="printer-grid-item-label">Status</span>
										<span className="printer-grid-item-value" style={selectedEntry.online ? undefined : { color: "var(--color-accent)" }}>
											{selectedEntry.online ? "Ready" : "Offline"}
										</span>
									</div>
								</div>
								<div className="printer-grid-item">
									<div className="printer-grid-item-icon"><PaperIcon /></div>
									<div className="printer-grid-item-details">
										<span className="printer-grid-item-label">System Default</span>
										<span className="printer-grid-item-value">{selectedEntry.local?.isDefault ? "Yes" : "No"}</span>
									</div>
								</div>
								<div className="printer-grid-item">
									<div className="printer-grid-item-icon"><RefreshIcon /></div>
									<div className="printer-grid-item-details">
										<span className="printer-grid-item-label">App Selection</span>
										<span className="printer-grid-item-value">{chosen === selectedEntry.name ? "Selected" : "Not selected"}</span>
									</div>
								</div>
							</div>
							{selectedEntry.local?.description && (
								<p style={{ fontSize: "12px", color: "var(--color-text-muted)", marginTop: "4px" }}>
									{selectedEntry.local.description}
								</p>
							)}
						</div>

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

						<div className="action-panel">
							<button
								className="btn-outline"
								onClick={() => handleTest(selectedEntry)}
								disabled={!selectedEntry.online || testState[selectedEntry.name] === "testing"}
							>
								{testState[selectedEntry.name] === "testing" ? (
									<>
										<div className="spinner spinner--dark" style={{ borderTopColor: "var(--color-primary)", width: "14px", height: "14px" }} />
										Printing…
									</>
								) : (
									<>
										<PrinterIcon />
										Print Test Doc
									</>
								)}
							</button>
							<button
								className="btn-gradient"
								onClick={() => handleSelect(selectedEntry)}
								disabled={!selectedEntry.online || saving || chosen === selectedEntry.name}
							>
								<CheckIcon />
								{chosen === selectedEntry.name ? "Selected Printer" : "Select This Printer"}
							</button>
						</div>
					</div>
				) : (
					<WelcomePane />
				)}
			</div>

			{addOpen && createPortal(
				<div className="modal-overlay" onClick={() => !addSaving && setAddOpen(false)}>
					<div className="modal-card modal-card--wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
						<h3 className="modal-title">Add a printer</h3>
						<p className="modal-message">
							Pick the connected printers you want to add to this shop. You can select more than one.
						</p>

						{addError && <div className="form-error">{addError}</div>}

						{addLoading ? (
							<div className="db-coming-soon">
								<div className="spinner spinner--dark" />
								<p>Finding printers…</p>
							</div>
						) : availableChoices.length === 0 ? (
							<div className="db-detail__empty">
								<p>
									{addChoices.length
										? "All connected printers have already been added."
										: "No online printers found. Connect a printer and try again."}
								</p>
							</div>
						) : (
							<div className="printer-pick-list">
								{availableChoices.map((p) => {
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
												<span className="printer-pick__meta">{p.isDefault ? "System default" : "Ready"}</span>
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
								disabled={addSaving || addSelected.length === 0}
							>
								{addSaving ? "Adding…" : `Confirm${addSelected.length ? ` (${addSelected.length})` : ""}`}
							</button>
						</div>
					</div>
				</div>,
				document.body
			)}

			{confirmDelete && createPortal(
				<ConfirmDialog
					title="Remove this printer?"
					message={`Remove “${confirmDelete.local?.displayName || confirmDelete.name}” from this shop? You can add it back later.`}
					confirmLabel="Remove"
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
