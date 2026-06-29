import React, { useState, useEffect, useCallback } from "react";
import ListColumn from "../components/ListColumn";
import WelcomePane from "../components/WelcomePane";
import { PrinterIcon, PaperIcon, CheckIcon, RefreshIcon } from "../icons";

// A Windows printer status of 0 means idle / ready; anything else needs a look.
function statusLabel(status) {
	return status === 0 ? "Ready" : "Check printer";
}

// Printers tab: real connected printers (via webContents.getPrintersAsync in the
// main process) with test-print and "select as default" actions.
function PrintersTab() {
	const [printers, setPrinters] = useState([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(null);
	const [selectedEntry, setSelectedEntry] = useState(null); // row open in the detail pane
	const [chosen, setChosen] = useState(null); // persisted selected printer name
	const [testState, setTestState] = useState({}); // name -> "testing" | "success" | "error"
	const [saving, setSaving] = useState(false);

	const loadPrinters = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [result, selected] = await Promise.all([
				window.electronAPI.listPrinters(),
				window.electronAPI.getSelectedPrinter(),
			]);
			if (result.success) setPrinters(result.data || []);
			else setError(result.message || "Failed to list printers.");
			setChosen(selected?.name || null);
		} catch (err) {
			console.error("[Renderer] failed to list printers:", err);
			setError("Failed to list printers.");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadPrinters();
	}, [loadPrinters]);

	const handleTest = async (printer) => {
		if (testState[printer.name] === "testing") return;
		setTestState((prev) => ({ ...prev, [printer.name]: "testing" }));
		try {
			const result = await window.electronAPI.testPrinter(printer.name);
			if (!result?.success) throw new Error(result?.message || "test failed");
			setTestState((prev) => ({ ...prev, [printer.name]: "success" }));
		} catch (err) {
			console.error("[Renderer] test print failed:", err);
			setTestState((prev) => ({ ...prev, [printer.name]: "error" }));
		}
		setTimeout(() => {
			setTestState((prev) => ({ ...prev, [printer.name]: null }));
		}, 3500);
	};

	const handleSelect = async (printer) => {
		setSaving(true);
		try {
			const result = await window.electronAPI.setSelectedPrinter({
				name: printer.name,
				displayName: printer.displayName,
			});
			if (!result?.success) throw new Error(result?.message || "save failed");
			setChosen(printer.name);
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
				count={printers.length}
				action={
					<button className="db-list__add" onClick={loadPrinters} title="Refresh">
						Refresh
					</button>
				}
			>
				{loading ? (
					<div className="db-coming-soon">
						<div className="spinner spinner--dark" />
						<p>Finding printers…</p>
					</div>
				) : error ? (
					<div className="db-coming-soon">
						<p>{error}</p>
					</div>
				) : printers.length === 0 ? (
					<div className="db-coming-soon">
						<p>No printers found</p>
						<p style={{ fontSize: "11.5px", color: "var(--color-text-secondary)" }}>
							Connect a printer and hit Refresh.
						</p>
					</div>
				) : (
					printers.map((printer) => (
						<button
							key={printer.name}
							className={`db-entry ${selectedEntry?.name === printer.name ? "db-entry--active" : ""}`}
							onClick={() => setSelectedEntry(printer)}
						>
							<div className={`db-entry__avatar ${chosen === printer.name ? "db-entry__avatar--chosen" : "db-entry__avatar--muted"}`}>
								<PrinterIcon />
							</div>
							<div className="db-entry__info">
								<span className="db-entry__name">{printer.displayName}</span>
								<span className="db-entry__meta">
									{statusLabel(printer.status)}{printer.isDefault ? " · System default" : ""}
								</span>
							</div>
							{chosen === printer.name && (
								<span className="db-status db-status--processing" style={{ fontSize: "9px", padding: "2px 6px" }}>
									Selected
								</span>
							)}
						</button>
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
										<span className="printer-grid-item-value">{selectedEntry.displayName}</span>
									</div>
								</div>
								<div className="printer-grid-item">
									<div className="printer-grid-item-icon"><CheckIcon /></div>
									<div className="printer-grid-item-details">
										<span className="printer-grid-item-label">Status</span>
										<span className="printer-grid-item-value">{statusLabel(selectedEntry.status)}</span>
									</div>
								</div>
								<div className="printer-grid-item">
									<div className="printer-grid-item-icon"><PaperIcon /></div>
									<div className="printer-grid-item-details">
										<span className="printer-grid-item-label">System Default</span>
										<span className="printer-grid-item-value">{selectedEntry.isDefault ? "Yes" : "No"}</span>
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
							{selectedEntry.description && (
								<p style={{ fontSize: "12px", color: "var(--color-text-muted)", marginTop: "4px" }}>
									{selectedEntry.description}
								</p>
							)}
						</div>

						{testState[selectedEntry.name] === "testing" && (
							<div className="printer-status-card" style={{ gap: "10px", padding: "16px", background: "rgba(0, 230, 173, 0.05)", borderColor: "var(--color-primary)" }}>
								<div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
									<div className="spinner spinner--dark" style={{ borderTopColor: "var(--color-primary)" }} />
									<span style={{ fontSize: "13px", fontWeight: "600", color: "var(--color-primary)" }}>
										Sending test page to {selectedEntry.displayName}…
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
								disabled={testState[selectedEntry.name] === "testing"}
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
								disabled={saving || chosen === selectedEntry.name}
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
		</>
	);
}

export default PrintersTab;
