import React, { useState } from "react";
import { DUMMY_PRINTERS } from "../data";
import ListColumn from "../components/ListColumn";
import WelcomePane from "../components/WelcomePane";
import { PrinterIcon, IpIcon, PaperIcon, LocIcon, CheckIcon } from "../icons";

// Printers tab: connected printers list + configuration / test-page panel.
function PrintersTab() {
	const [selectedEntry, setSelectedEntry] = useState(null);

	// Simulated printer test-page state: printerId -> "testing" | "success"
	const [simulatedPrinterState, setSimulatedPrinterState] = useState({});

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
		<>
			<ListColumn title="Printers">
				{DUMMY_PRINTERS.map((entry) => (
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
				))}
			</ListColumn>

			<div className="db-detail">
				{selectedEntry ? (
					<div className="db-detail__view">
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
					</div>
				) : (
					<WelcomePane />
				)}
			</div>
		</>
	);
}

export default PrintersTab;
