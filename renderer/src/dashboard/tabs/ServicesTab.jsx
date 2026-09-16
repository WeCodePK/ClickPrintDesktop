import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import ListColumn from "../components/ListColumn";
import WelcomePane from "../components/WelcomePane";
import ConfirmDialog from "../components/ConfirmDialog";
import ServiceForm, { serviceLabel, sameKeys, printerIdOf, loadServicePrinters } from "../components/ServiceForm";
import { useAutoPrint } from "../AutoPrintContext";
import { TrashIcon, EditIcon, CheckIcon, BoltIcon, WalletIcon, PaperIcon, PagesIcon, StackIcon, EyeIcon } from "../icons";

// Services tab: the shop's print services in a left list column (like the
// Printers tab), with the selected service's configuration in the detail pane.
// Creating or editing opens the form in a modal.
function ServicesTab() {
	// Service edits change where documents auto-route, so the shared routing
	// state in AutoPrintContext is refreshed after every save/delete/toggle.
	const { refreshPrinterState } = useAutoPrint();

	const [services, setServices] = useState([]);
	const [printers, setPrinters] = useState([]); // registered printers + live online flag
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(null);
	const [selectedId, setSelectedId] = useState(null);
	const [editing, setEditing] = useState(null); // service object, { keys: {} } for new, or null
	const [saving, setSaving] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(null);
	const [pendingOverwrite, setPendingOverwrite] = useState(null);
	const [togglingId, setTogglingId] = useState(null); // service whose enable/disable is in flight

	useEffect(() => {
		setError(null);
		setPendingOverwrite(null);
	}, [editing]);

	const loadServices = useCallback(async () => {
		try {
			const result = await window.electronAPI.fetchServices();
			if (result.success) setServices(result.data || []);
			else setError(result.message || "Failed to load services.");
		} catch (err) {
			console.error("[Renderer] failed to load services:", err);
			setError("Failed to load services.");
		}
	}, []);

	// The shop's registered printers, each tagged with whether it's reachable
	// right now — mirrors the Printers tab's merge.
	const loadPrinters = useCallback(async () => {
		try {
			const list = await loadServicePrinters();
			if (list) setPrinters(list);
		} catch (err) {
			console.error("[Renderer] failed to load printers:", err);
		}
	}, []);

	useEffect(() => {
		(async () => {
			setLoading(true);
			setError(null);
			await Promise.all([loadServices(), loadPrinters()]);
			setLoading(false);
		})();
	}, [loadServices, loadPrinters]);

	const selectedService = services.find((s) => s._id === selectedId) || null;

	// The selected service's printers resolved against the registered list. Kept
	// even when the printer can't be resolved (deleted / not populated) so the
	// row count stays honest.
	const boundPrinters = (selectedService?.printers || []).map((entry) => ({
		useAuto: entry.useAuto,
		printer: printers.find((p) => p._id === printerIdOf(entry)) || null,
	}));

	// ── Save (create / edit) ───────────────────────────────────────────────────
	const handleSave = async (data) => {
		if (!editing._id) {
			const existingService = services.find((p) => sameKeys(p.keys, data.keys));
			if (existingService) {
				setPendingOverwrite({ existingService, data });
				return;
			}
		}

		setSaving(true);
		setError(null);
		try {
			const result = editing._id
				? await window.electronAPI.updateService(editing._id, data)
				: await window.electronAPI.createService(data);
			if (result.success) {
				await loadServices();
				refreshPrinterState();
				setEditing(null);
			} else {
				setError(result.message || "Failed to save service.");
			}
		} finally {
			setSaving(false);
		}
	};

	const handleConfirmOverwrite = async () => {
		if (!pendingOverwrite) return;
		const { existingService, data } = pendingOverwrite;
		setPendingOverwrite(null);
		setSaving(true);
		setError(null);
		try {
			const result = await window.electronAPI.updateService(existingService._id, data);
			if (result.success) {
				await loadServices();
				refreshPrinterState();
				setEditing(null);
			} else {
				setError(result.message || "Failed to overwrite service.");
			}
		} finally {
			setSaving(false);
		}
	};

	// ── Delete ─────────────────────────────────────────────────────────────────
	const handleDelete = async (service) => {
		setConfirmDelete(null);
		setSaving(true);
		try {
			const result = await window.electronAPI.deleteService(service._id);
			if (result.success) {
				if (selectedId === service._id) setSelectedId(null);
				await loadServices();
				refreshPrinterState();
			} else {
				setError(result.message || "Failed to delete service.");
			}
		} finally {
			setSaving(false);
		}
	};

	// ── Enable / disable ───────────────────────────────────────────────────────
	const handleToggleDisabled = async (service) => {
		if (togglingId) return;
		setTogglingId(service._id);
		try {
			const result = await window.electronAPI.setServiceDisabled(service._id, !service.isDisabled);
			if (!result?.success) throw new Error(result?.message || "update failed");
			// Prefer the server's returned service; fall back to flipping locally.
			const updated = result.data && result.data._id ? result.data : { ...service, isDisabled: !service.isDisabled };
			setServices((prev) => prev.map((s) => (s._id === service._id ? { ...s, ...updated } : s)));
			refreshPrinterState();
		} catch (err) {
			console.error("[Renderer] failed to toggle service disabled state:", err);
		} finally {
			setTogglingId(null);
		}
	};

	return (
		<>
			<ListColumn
				title="Services"
				count={services.length}
				action={
					<button className="db-list__add" onClick={() => setEditing({ keys: {} })} title="Add a service">
						+ Add
					</button>
				}
			>
				{loading ? (
					<div className="db-coming-soon">
						<div className="spinner spinner--dark" />
						<p>Loading services…</p>
					</div>
				) : error && !editing ? (
					<div className="db-coming-soon">
						<p>{error}</p>
					</div>
				) : services.length === 0 ? (
					<div className="db-coming-soon">
						<p>No services added</p>
						<p style={{ fontSize: "11.5px", color: "var(--color-text-secondary)" }}>
							Use “+ Add” to create your first print service.
						</p>
					</div>
				) : (
					services.map((service) => (
						<div
							key={service._id}
							className={`db-entry ${selectedId === service._id ? "db-entry--active" : ""} ${service.isDisabled ? "db-entry--offline" : ""}`}
							role="button"
							tabIndex={0}
							onClick={() => setSelectedId(service._id)}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									setSelectedId(service._id);
								}
							}}
						>
							<div className={`db-entry__avatar ${service.isDisabled ? "db-entry__avatar--muted" : ""}`}>
								<WalletIcon />
							</div>
							<div className="db-entry__info">
								<span className="db-entry__name">{service.name || serviceLabel(service.keys)}</span>
								<span className="db-entry__meta">
									{service.isDisabled ? "Disabled" : serviceLabel(service.keys)}
								</span>
							</div>
							<div className="db-entry__price-actions">
								<span className="db-entry__price">Rs. {service.rate}</span>
								<button
									type="button"
									className={`toggle ${service.isDisabled ? "" : "toggle--on"}`}
									role="switch"
									aria-checked={!service.isDisabled}
									title={service.isDisabled ? "Enable this service" : "Disable this service"}
									disabled={togglingId === service._id}
									onClick={(e) => {
										e.stopPropagation();
										handleToggleDisabled(service);
									}}
								>
									<span className="toggle__knob" />
								</button>
							</div>
						</div>
					))
				)}
			</ListColumn>

			<div className="db-detail">
				{selectedService ? (
					<div className="db-detail__view">
						<h3 className="db-detail__title">Service Configuration</h3>

						<div className="printer-status-card">
							<div className="printer-grid">
								<div className="printer-grid-item">
									<div className="printer-grid-item-icon"><PagesIcon /></div>
									<div className="printer-grid-item-details">
										<span className="printer-grid-item-label">Service</span>
										<span className="printer-grid-item-value">{selectedService.name || serviceLabel(selectedService.keys)}</span>
									</div>
								</div>
								<div className="printer-grid-item">
									<div className="printer-grid-item-icon"><CheckIcon /></div>
									<div className="printer-grid-item-details">
										<span className="printer-grid-item-label">Status</span>
										<span className="printer-grid-item-value" style={selectedService.isDisabled ? { color: "var(--color-accent)" } : undefined}>
											{selectedService.isDisabled ? "Disabled" : "Active"}
										</span>
									</div>
								</div>
								<div className="printer-grid-item">
									<div className="printer-grid-item-icon"><WalletIcon /></div>
									<div className="printer-grid-item-details">
										<span className="printer-grid-item-label">Rate</span>
										<span className="printer-grid-item-value">Rs. {selectedService.rate} / page</span>
									</div>
								</div>
								<div className="printer-grid-item">
									<div className="printer-grid-item-icon"><PaperIcon /></div>
									<div className="printer-grid-item-details">
										<span className="printer-grid-item-label">Paper Size</span>
										<span className="printer-grid-item-value">{selectedService.keys?.pageType || "—"}</span>
									</div>
								</div>
								<div className="printer-grid-item">
									<div className="printer-grid-item-icon"><EyeIcon /></div>
									<div className="printer-grid-item-details">
										<span className="printer-grid-item-label">Color</span>
										<span className="printer-grid-item-value">{selectedService.keys?.color ? "Color" : "Black & White"}</span>
									</div>
								</div>
								<div className="printer-grid-item">
									<div className="printer-grid-item-icon"><StackIcon /></div>
									<div className="printer-grid-item-details">
										<span className="printer-grid-item-label">Sidedness</span>
										<span className="printer-grid-item-value">{selectedService.keys?.sidedness ? "Double Sided" : "Single Sided"}</span>
									</div>
								</div>
							</div>
						</div>

						{boundPrinters.length > 0 && (
							<div className="printer-status-card">
								<span className="printer-grid-item-label">Assigned Printers</span>
								<div className="db-entry__meta--printers" style={{ gap: "6px", marginTop: "6px" }}>
									{boundPrinters.map(({ printer, useAuto }, i) => (
										<span className="printer-row" key={printer?._id || i}>
											{useAuto && <span className="printer-row__auto" title="Automated"><BoltIcon /></span>}
											<span className="printer-row__label">{printer?.label || "Unknown printer"}</span>
											<span className={`printer-dot ${printer?.online ? "printer-dot--on" : "printer-dot--off"}`} />
										</span>
									))}
								</div>
							</div>
						)}

						<div className="action-panel">
							<button className="btn-outline" onClick={() => setEditing(selectedService)}>
								<EditIcon />
								Edit Service
							</button>
							<button
								className="btn-outline"
								style={{ color: "var(--color-accent)", borderColor: "var(--color-accent)" }}
								onClick={() => setConfirmDelete(selectedService)}
							>
								<TrashIcon />
								Remove Service
							</button>
						</div>

						{selectedService.isDisabled && (
							<div className="printer-status-card" style={{ gap: "10px", padding: "16px", background: "rgba(255, 87, 10, 0.08)", borderColor: "var(--color-accent)" }}>
								<span style={{ fontSize: "13px", fontWeight: "600", color: "var(--color-accent)" }}>
									This service is disabled. Use its toggle in the list to enable it again.
								</span>
							</div>
						)}
					</div>
				) : (
					<WelcomePane />
				)}
			</div>

			{editing && createPortal(
				<div className="modal-overlay" onClick={() => !saving && setEditing(null)}>
					<div className="modal-card modal-card--wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
						<ServiceForm
							key={editing._id || "new"}
							service={editing}
							printers={printers}
							error={error}
							saving={saving}
							onSave={handleSave}
							onCancel={() => setEditing(null)}
						/>
					</div>
				</div>,
				document.body
			)}

			{confirmDelete && createPortal(
				<ConfirmDialog
					title="Delete this service?"
					message={`Are you sure you want to delete "${confirmDelete.name || serviceLabel(confirmDelete.keys)}"? This cannot be undone.`}
					confirmLabel="Delete"
					cancelLabel="Cancel"
					danger
					onConfirm={() => handleDelete(confirmDelete)}
					onCancel={() => setConfirmDelete(null)}
				/>,
				document.body
			)}

			{pendingOverwrite && createPortal(
				<ConfirmDialog
					title="Overwrite Service"
					message={`A service for "${pendingOverwrite.existingService.name || serviceLabel(pendingOverwrite.existingService.keys)}" already exists. Overwrite the existing service with this new rate?`}
					confirmLabel="Overwrite Service"
					cancelLabel="Cancel"
					onConfirm={handleConfirmOverwrite}
					onCancel={() => setPendingOverwrite(null)}
				/>,
				document.body
			)}
		</>
	);
}

export default ServicesTab;
