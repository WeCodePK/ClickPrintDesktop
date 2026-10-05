import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import ListColumn from "../components/ListColumn";
import WelcomePane from "../components/WelcomePane";
import EmptyState from "../components/EmptyState";
import StaleNote from "../components/StaleNote";
import { useNetStatus, OFFLINE_ACTION_HINT } from "../useNetStatus";
import ConfirmDialog from "../components/ConfirmDialog";
import ServiceForm, { serviceLabel, sameKeys, printerIdOf, loadServicePrinters, PAGE_TYPES, serviceCode } from "../components/ServiceForm";
import { useAutoPrint } from "../AutoPrintContext";
import { TrashIcon, EditIcon, BoltIcon, PrinterIcon, SvcPaperGlyph, SvcBwGlyph, SvcColorGlyph, SvcSingleGlyph, SvcDoubleGlyph, ChevronDownIcon, AlertIcon } from "../icons";

// Services grouped paper size → color → sidedness for the list column's tree.
// Only paper sizes with a service appear; under each, every color/sides slot is
// listed, with `service: null` marking a combination the shop doesn't offer yet.
function buildServiceTree(services) {
	const sizes = [...new Set(services.map((s) => s.keys?.pageType || "—"))].sort((a, b) => {
		const ia = PAGE_TYPES.indexOf(a);
		const ib = PAGE_TYPES.indexOf(b);
		return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib) || a.localeCompare(b);
	});
	return sizes.map((size) => {
		const inSize = services.filter((s) => (s.keys?.pageType || "—") === size);
		const colors = [false, true].map((color) => {
			const slots = [false, true].map((sidedness) => ({
				sidedness,
				service: inSize.find((s) => !!s.keys?.color === color && !!s.keys?.sidedness === sidedness) || null,
			}));
			return {
				color,
				label: color ? "Color" : "Black & White",
				Glyph: color ? SvcColorGlyph : SvcBwGlyph,
				slots,
				empty: slots.every((slot) => !slot.service),
			};
		});
		return { size, colors };
	});
}

// Services settings section: the shop's print services in a left list column
// (like the Printers section), with the selected service's configuration in the
// detail pane. Creating or editing opens the form in a modal.
function ServicesTab() {
	// Service edits change where documents auto-route, so the shared routing
	// state in AutoPrintContext is refreshed after every save/delete/toggle.
	const { refreshPrinterState } = useAutoPrint();

	const [services, setServices] = useState([]);
	const [printers, setPrinters] = useState([]); // registered printers + live online flag
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(null);
	// { stale, fetchedAt } — set when the list is the copy saved before the
	// connection dropped. Editing needs the backend, so it waits for it.
	const [saved, setSaved] = useState({ stale: false, fetchedAt: null });
	const net = useNetStatus();
	const offline = !net.online;
	const offlineTitle = offline ? OFFLINE_ACTION_HINT : undefined;
	const [selectedId, setSelectedId] = useState(null);
	const [editing, setEditing] = useState(null); // service object, { keys: {} } for new, or null
	const [saving, setSaving] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(null);
	const [pendingOverwrite, setPendingOverwrite] = useState(null);
	const [togglingId, setTogglingId] = useState(null); // service whose enable/disable is in flight
	const [collapsedSizes, setCollapsedSizes] = useState(() => new Set()); // folded paper-size groups in the tree

	useEffect(() => {
		setError(null);
		setPendingOverwrite(null);
	}, [editing]);

	const loadServices = useCallback(async () => {
		try {
			const result = await window.electronAPI.fetchServices();
			if (result.success) {
				setServices(result.data || []);
				setSaved({ stale: !!result.stale, fetchedAt: result.fetchedAt || null });
				setError(null);
				return result.data || [];
			}
			setError(result.message || "Failed to load services.");
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

	// Back online: replace a saved (or missing) list with the real one.
	useEffect(() => {
		if (net.online && (saved.stale || error)) {
			loadServices();
			loadPrinters();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [net.online]);

	const selectedService = services.find((s) => s._id === selectedId) || null;

	const serviceTree = buildServiceTree(services);

	// Select a just-saved service, unfolding its paper-size group if needed.
	// Matched by id when the server returned one, else by its option keys.
	const focusService = (list, saved, keys) => {
		const match = (list || []).find((s) => (saved?._id ? s._id === saved._id : sameKeys(s.keys, keys)));
		if (!match) return;
		setSelectedId(match._id);
		const size = match.keys?.pageType || "—";
		setCollapsedSizes((prev) => {
			if (!prev.has(size)) return prev;
			const next = new Set(prev);
			next.delete(size);
			return next;
		});
	};

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
				const list = await loadServices();
				if (!editing._id) focusService(list, result.data, data.keys);
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
				const list = await loadServices();
				focusService(list, existingService, data.keys);
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
				bodyClassName="db-list__entries--column"
				action={
					<button
						className="db-list__add"
						onClick={() => setEditing({ keys: {} })}
						disabled={offline}
						title={offlineTitle || "Add a service"}
					>
						+ Add
					</button>
				}
			>
				<StaleNote stale={saved.stale} fetchedAt={saved.fetchedAt} />
				{loading ? (
					<div className="db-coming-soon">
						<div className="spinner spinner--dark" />
						<p>Loading services…</p>
					</div>
				) : error && !editing && services.length === 0 ? (
					<div className="db-coming-soon">
						<p>{offline ? "You're offline — your services will appear once the connection is back." : error}</p>
						<button type="button" className="btn-outline btn-sm" onClick={loadServices}>
							Try again
						</button>
					</div>
				) : services.length === 0 ? (
					<EmptyState art="service" title="No services added" />
				) : (
					<ul className="svc-tree" role="tree">
						{serviceTree.map(({ size, colors }) => (
							<li key={size} role="treeitem" aria-expanded={!collapsedSizes.has(size)}>
								<button
									type="button"
									className={`svc-tree__group svc-tree__group--size ${collapsedSizes.has(size) ? "svc-tree__group--folded" : ""}`}
									onClick={() =>
										setCollapsedSizes((prev) => {
											const next = new Set(prev);
											if (next.has(size)) next.delete(size);
											else next.add(size);
											return next;
										})
									}
								>
									<span className="svc-tree__icon"><SvcPaperGlyph /></span>
									{size}
									<span className="svc-tree__chevron"><ChevronDownIcon /></span>
								</button>
								<ul role="group" hidden={collapsedSizes.has(size)}>
									{colors.map(({ color, label, Glyph, slots, empty }) =>
										empty ? (
											// Whole color group missing: one faint row to add it.
											<li key={label} role="treeitem">
												<button
													type="button"
													className="svc-tree__group svc-tree__ghost"
													title={offlineTitle || `No ${label} services for ${size} yet. Click to add one.`}
													disabled={offline}
													onClick={() => setEditing({ keys: { pageType: size, color, sidedness: false } })}
												>
													<span className="svc-tree__icon"><Glyph /></span>
													{label}
													<span className="svc-tree__ghost-mark"><AlertIcon /></span>
												</button>
											</li>
										) : (
											<li key={label} role="treeitem" aria-expanded="true">
												<div className="svc-tree__group">
													<span className="svc-tree__icon"><Glyph /></span>
													{label}
												</div>
												<ul role="group">
													{slots.map(({ sidedness, service }) => {
														const SideGlyph = sidedness ? SvcDoubleGlyph : SvcSingleGlyph;
														const sideLabel = sidedness ? "Double Sided" : "Single Sided";
														if (!service) {
															return (
																<li key={String(sidedness)} role="treeitem">
																	<button
																		type="button"
																		className="svc-tree__leaf svc-tree__ghost"
																		title={offlineTitle || `No ${size} ${label} ${sideLabel} service yet. Click to add it.`}
																		disabled={offline}
																		onClick={() => setEditing({ keys: { pageType: size, color, sidedness } })}
																	>
																		<span className="svc-tree__icon"><SideGlyph /></span>
																		<span className="svc-tree__label">{sideLabel}</span>
																		<span className="svc-tree__ghost-mark"><AlertIcon /></span>
																	</button>
																</li>
															);
														}
														return (
															<li
																key={service._id}
																role="treeitem"
																aria-selected={selectedId === service._id}
																tabIndex={0}
																title={service.name || serviceLabel(service.keys)}
																className={`svc-tree__leaf ${selectedId === service._id ? "svc-tree__leaf--active" : ""} ${service.isDisabled ? "svc-tree__leaf--off" : ""}`}
																onClick={() => setSelectedId(service._id)}
																onKeyDown={(e) => {
																	if (e.key === "Enter" || e.key === " ") {
																		e.preventDefault();
																		setSelectedId(service._id);
																	}
																}}
															>
																<span className="svc-tree__icon"><SideGlyph /></span>
																<span className="svc-tree__label">{sideLabel}</span>
																<span className="svc-tree__price">Rs. {service.rate}</span>
															</li>
														);
													})}
												</ul>
											</li>
										)
									)}
								</ul>
							</li>
						))}
					</ul>
				)}
			</ListColumn>

			<div className="db-detail">
				{selectedService ? (
					<div className="db-detail__view">
						<div className="db-detail__titlebar">
							<div className="db-detail__heading">
								<h3 className="db-detail__title">{selectedService.name || serviceLabel(selectedService.keys)}</h3>
								{selectedService.name && selectedService.name !== serviceLabel(selectedService.keys) && (
									<p className="db-detail__subtitle">{serviceLabel(selectedService.keys)}</p>
								)}
							</div>
							<div className="db-detail__titlebar-actions">
								<button
									type="button"
									className="btn-outline"
									onClick={() => setEditing(selectedService)}
									disabled={offline}
									title={offlineTitle}
								>
									<EditIcon />
									Edit
								</button>
								<button
									type="button"
									className="btn-outline db-detail__remove"
									onClick={() => setConfirmDelete(selectedService)}
									disabled={offline}
									title={offlineTitle}
								>
									<TrashIcon />
									Delete
								</button>
								<button
									type="button"
									className={`toggle ${selectedService.isDisabled ? "" : "toggle--on"}`}
									role="switch"
									aria-checked={!selectedService.isDisabled}
									title={offlineTitle || (selectedService.isDisabled ? "Enable this service" : "Disable this service")}
									disabled={togglingId === selectedService._id || offline}
									onClick={() => handleToggleDisabled(selectedService)}
								>
									<span className="toggle__knob" />
								</button>
							</div>
						</div>

						{selectedService.isDisabled && (
							<div className="printer-alerts">
								<div className="printer-status-card" style={{ gap: "10px", padding: "16px", background: "rgba(134, 150, 160, 0.08)", borderColor: "var(--border-light)" }}>
									<span style={{ fontSize: "13px", fontWeight: "600", color: "var(--color-text-secondary)" }}>
										This service is disabled.
									</span>
								</div>
							</div>
						)}

						<div className={`svc-card ${selectedService.isDisabled ? "svc-card--off" : ""}`}>
							<div className="svc-card__price">
								<span className="svc-card__label">Price</span>
								<div className="svc-card__amount">
									<span className="svc-card__currency">Rs.</span>
									<span className="svc-card__value">{selectedService.rate}</span>
									<span className="svc-card__unit">/ page</span>
								</div>
							</div>

							<div className="svc-card__section">
								<div className="svc-card__section-head">
									<span className="svc-card__label">Printers</span>
									<span className="svc-card__count">{boundPrinters.length}</span>
								</div>
								{boundPrinters.length === 0 ? (
									<p className="svc-card__empty">No printers assigned. Edit the service to add one.</p>
								) : (
									<ul className="svc-card__printers">
										{boundPrinters.map(({ printer, useAuto }, i) => (
											<li className="svc-card__printer" key={printer?._id || i}>
												<span className="svc-card__printer-icon"><PrinterIcon /></span>
												<span className="svc-card__printer-name">{printer?.label || "Unknown printer"}</span>
												{useAuto && (
													<span className="svc-card__auto" title="Jobs for this service print automatically">
														<BoltIcon />
														Auto
													</span>
												)}
												<span className={`svc-card__status ${printer?.online ? "svc-card__status--on" : ""}`}>
													<span className={`printer-dot ${printer?.online ? "printer-dot--on" : "printer-dot--off"}`} />
													{printer?.online ? "Online" : "Offline"}
												</span>
											</li>
										))}
									</ul>
								)}
							</div>
						</div>

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
							offline={offline}
							onSave={handleSave}
							onCancel={() => setEditing(null)}
						/>
					</div>
				</div>,
				document.body
			)}

			{confirmDelete && createPortal(
				<ConfirmDialog
					title={`Delete ${serviceCode(confirmDelete.keys)}?`}
					message="Are you sure you want to delete this service?"
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
