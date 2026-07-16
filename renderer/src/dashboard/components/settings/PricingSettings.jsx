import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import ConfirmDialog from "../ConfirmDialog";
import { Segmented } from "./Segmented";
import PrinterSelect from "./PrinterSelect";
import { TrashIcon, EditIcon, CheckIcon } from "../../icons";

const PAGE_TYPES = ["A4", "A5", "A3", "Letter", "Legal"];
const RATE_MIN = 1;
const RATE_MAX = 200;

function serviceLabel(keys = {}) {
	return `${keys.pageType || "—"}, ${keys.colored ? "Color" : "Black & White"}, ${keys.sidedness ? "Double Sided" : "Single Sided"}`;
}

// Two services clash when they price the same print configuration.
function sameKeys(a = {}, b = {}) {
	return (
		a.pageType === b.pageType &&
		!!a.colored === !!b.colored &&
		!!a.sidedness === !!b.sidedness
	);
}

// A service's printer id, whether the backend returns it raw or populated.
function printerIdOf(entry) {
	if (!entry) return "";
	return typeof entry.printer === "string" ? entry.printer : entry.printer?._id || "";
}

// Create / edit form for a single service, shown inside a modal. Remounted
// (keyed) per selection so the fields reset cleanly.
function PriceForm({ price, printers, error, saving, onSave, onCancel }) {
	const isNew = !price._id;
	const [rate, setRate] = useState(price.rate ?? "");
	const [colored, setColored] = useState(price.keys?.colored ?? false);
	const [pageType, setPageType] = useState(price.keys?.pageType || "A4");
	const [sidedness, setSidedness] = useState(price.keys?.sidedness ?? false);

	// One entry per selected printer. `useAuto` starts null so the operator has to
	// make an explicit Yes/No choice for each.
	const [printerSel, setPrinterSel] = useState(() =>
		(price.printers || [])
			.map((entry) => ({ printer: printerIdOf(entry), useAuto: entry.useAuto ?? null }))
			.filter((entry) => entry.printer)
	);

	const selectedIds = printerSel.map((p) => p.printer);

	// Keep the per-printer rows in sync with the dropdown, preserving any Yes/No
	// already chosen for printers that stay selected.
	const handlePrintersChange = (ids) =>
		setPrinterSel(
			ids.map((id) => printerSel.find((p) => p.printer === id) || { printer: id, useAuto: null })
		);

	const setUseAutoFor = (id, useAuto) =>
		setPrinterSel((prev) => prev.map((p) => (p.printer === id ? { ...p, useAuto } : p)));

	const name = serviceLabel({ pageType, colored, sidedness });
	const rateNum = Number(rate);
	const isRateInvalid = rate === "" || isNaN(rateNum) || rateNum < RATE_MIN || rateNum > RATE_MAX;
	const noPrinters = printers.length === 0;
	const autoUnanswered = printerSel.some((p) => p.useAuto === null);
	const isSubmitDisabled = saving || isRateInvalid || printerSel.length === 0 || autoUnanswered;

	const submit = (e) => {
		e.preventDefault();
		onSave({
			rate: rateNum || 0,
			keys: { pageType, colored, sidedness },
			printers: printerSel.map((p) => ({ useAuto: !!p.useAuto, printer: p.printer })),
		});
	};

	return (
		<form className="price-form" onSubmit={submit}>
			<h3 className="modal-title">{isNew ? "New Price" : "Edit Price"}</h3>

			{error && <div className="form-error">{error}</div>}

			<div className="form-field">
				<label className="form-label" style={{ marginBottom: "2.5rem", textAlign: "center" }}>{name}</label>
			</div>

			<div className="form-field">
				<label className="form-label">Rate (Rs. per page)</label>
				<input
					className="form-input"
					type="number"
					min={RATE_MIN}
					max={RATE_MAX}
					step="1"
					value={rate}
					onChange={(e) => setRate(e.target.value)}
					required
				/>
				{isRateInvalid && (
					<span className="form-hint">Enter a rate between Rs. {RATE_MIN} and Rs. {RATE_MAX} per page.</span>
				)}
			</div>

			<div className="form-field">
				<label className="form-label">Paper Size</label>
				<select className="form-input" value={pageType} onChange={(e) => setPageType(e.target.value)}>
					{PAGE_TYPES.map((pt) => (
						<option key={pt} value={pt}>{pt}</option>
					))}
				</select>
			</div>

			<div className="form-field">
				<label className="form-label">Color</label>
				<Segmented
					value={colored}
					onChange={setColored}
					options={[
						{ label: "Black & White", value: false, activeClass: "segmented__btn--active" },
						{ label: "Color", value: true, activeClass: "segmented__btn--colorful" },
					]}
				/>
			</div>

			<div className="form-field">
				<label className="form-label">Sidedness</label>
				<Segmented
					value={sidedness}
					onChange={setSidedness}
					options={[
						{ label: "Single", value: false },
						{ label: "Double", value: true },
					]}
				/>
			</div>

			<div className="form-field">
				<label className="form-label">Printers</label>
				<PrinterSelect
					printers={printers}
					value={selectedIds}
					onChange={handlePrintersChange}
					disabled={saving || noPrinters}
				/>
				{(noPrinters || printerSel.length === 0) && (
					<span className="form-hint">
						{noPrinters
							? "Add a printer in the Printers tab before creating a service."
							: "Select one or more printers to be assigned to this service."}
					</span>
				)}
			</div>

			{printerSel.length > 0 && (
				<div className="form-field">
					<label className="form-label">Automated printing</label>
					<div className="auto-list">
						{printerSel.map((sel) => {
							const printer = printers.find((p) => p._id === sel.printer);
							return (
								<div className="auto-row" key={sel.printer}>
									<span className="auto-row__printer">
										<span className={`printer-dot ${printer?.online ? "printer-dot--on" : "printer-dot--off"}`} />
										{printer?.label || "Unknown printer"}
									</span>
									<span className="auto-row__choices">
										{[
											{ label: "Yes", choice: true },
											{ label: "No", choice: false },
										].map(({ label, choice }) => {
											const on = sel.useAuto === choice;
											return (
												<button
													type="button"
													key={label}
													className={`form-check ${on ? "form-check--on" : ""}`}
													onClick={() => setUseAutoFor(sel.printer, choice)}
													role="checkbox"
													aria-checked={on}
													disabled={saving}
												>
													<span className="form-check__box">{on && <CheckIcon />}</span>
													<span className="form-check__label">{label}</span>
												</button>
											);
										})}
									</span>
								</div>
							);
						})}
					</div>
					{autoUnanswered && (
						<span className="form-hint">
							Choose whether each printer can be used for automated printing on this service.
						</span>
					)}
				</div>
			)}

			<div className="action-panel">
				<button type="button" className="btn-outline" onClick={onCancel} disabled={saving}>
					Cancel
				</button>
				<button type="submit" className="btn-gradient" disabled={isSubmitDisabled}>
					{saving ? "Saving…" : isNew ? "Create Price" : "Save Changes"}
				</button>
			</div>
		</form>
	);
}

// Pricing settings panel — the shop's print services CRUD, rendered in the right
// detail pane. The list lives here with a "New Price" action; creating or
// editing opens the form in a modal.
function PricingSettings() {
	const [prices, setPrices] = useState([]);
	const [printers, setPrinters] = useState([]); // registered printers + live online flag
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(null);
	const [editing, setEditing] = useState(null); // service object, { keys: {} } for new, or null
	const [saving, setSaving] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(null);
	const [pendingOverwrite, setPendingOverwrite] = useState(null);

	useEffect(() => {
		setError(null);
		setPendingOverwrite(null);
	}, [editing]);

	const loadPrices = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await window.electronAPI.fetchServices();
			if (result.success) setPrices(result.data || []);
			else setError(result.message || "Failed to load prices.");
		} catch (err) {
			console.error("[Renderer] failed to load services:", err);
			setError("Failed to load prices.");
		} finally {
			setLoading(false);
		}
	}, []);

	// The shop's registered printers, each tagged with whether it's reachable
	// right now — mirrors the Printers tab's merge.
	const loadPrinters = useCallback(async () => {
		try {
			const [registered, local] = await Promise.all([
				window.electronAPI.fetchPrinters(),
				window.electronAPI.listPrinters(),
			]);
			if (!registered?.success) return;
			const localByName = new Map(
				(local?.success ? local.data || [] : []).map((p) => [p.name, p])
			);
			setPrinters(
				(registered.data || []).map((p) => ({
					_id: p._id,
					name: p.name,
					label: localByName.get(p.name)?.displayName || p.name,
					online: localByName.has(p.name),
				}))
			);
		} catch (err) {
			console.error("[Renderer] failed to load printers:", err);
		}
	}, []);

	useEffect(() => {
		loadPrices();
		loadPrinters();
	}, [loadPrices, loadPrinters]);

	const handleSave = async (data) => {
		if (!editing._id) {
			const existingPrice = prices.find((p) => sameKeys(p.keys, data.keys));
			if (existingPrice) {
				setPendingOverwrite({ existingPrice, data });
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
				await loadPrices();
				setEditing(null);
			} else {
				setError(result.message || "Failed to save price.");
			}
		} finally {
			setSaving(false);
		}
	};

	const handleConfirmOverwrite = async () => {
		if (!pendingOverwrite) return;
		const { existingPrice, data } = pendingOverwrite;
		setPendingOverwrite(null);
		setSaving(true);
		setError(null);
		try {
			const result = await window.electronAPI.updateService(existingPrice._id, data);
			if (result.success) {
				await loadPrices();
				setEditing(null);
			} else {
				setError(result.message || "Failed to overwrite price.");
			}
		} finally {
			setSaving(false);
		}
	};

	const handleDelete = async (price) => {
		setConfirmDelete(null);
		setSaving(true);
		setError(null);
		try {
			const result = await window.electronAPI.deleteService(price._id);
			if (result.success) {
				await loadPrices();
				setEditing(null);
			} else {
				setError(result.message || "Failed to delete price.");
			}
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="db-detail__view">
			<div className="settings-panel__header">
				<div>
					<h3 className="db-detail__title" style={{ marginBottom: "4px" }}>Pricing</h3>
					<p className="settings-panel__sub">Manage the print rates customers are charged.</p>
				</div>
				<button className="btn-gradient settings-panel__action" onClick={() => setEditing({ keys: {} })}>
					+ New Price
				</button>
			</div>

			{error && !editing && <div className="form-error">{error}</div>}

			{loading ? (
				<div className="db-coming-soon">
					<div className="spinner spinner--dark" />
					<p>Loading prices…</p>
				</div>
			) : prices.length === 0 ? (
				<div className="db-detail__empty">
					<p>No prices yet. Add your first print price to get started.</p>
				</div>
			) : (
				<div className="price-list">
					{prices.map((price) => {
						const bound = (price.printers || [])
							.map((entry) => ({
								useAuto: entry.useAuto,
								printer: printers.find((p) => p._id === printerIdOf(entry)),
							}))
							.filter((entry) => entry.printer);
						return (
							<div
								key={price._id}
								className="db-entry db-entry--price"
								role="button"
								tabIndex={0}
								onClick={() => setEditing(price)}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										setEditing(price);
									}
								}}
							>
								<div className="db-entry__info">
									<span className="db-entry__name">{price.name || serviceLabel(price.keys)}</span>
									<span className="db-entry__meta">
										{price.keys?.pageType} · {price.keys?.colored ? "Color" : "Black & White"} · {price.keys?.sidedness ? "Double" : "Single"}
										{bound.map(({ printer, useAuto }) => (
											<span key={printer._id}>
												{" · "}
												{printer.label}
												{" "}
												<span style={{ justifyContent: "center", alignItems: "center" }} className={`printer-dot ${printer.online ? "printer-dot--on" : "printer-dot--off"}`} />
												{useAuto && " (Auto)"}
											</span>
										))}
									</span>
								</div>
								<div className="db-entry__price-actions">
									<span className="db-entry__price">Rs. {price.rate}</span>
									<button
										type="button"
										className="db-entry__delete-btn db-entry__edit-btn"
										title="Edit this price"
										onClick={(e) => {
											e.stopPropagation();
											setEditing(price);
										}}
									>
										<EditIcon />
									</button>
									<button
										type="button"
										className="db-entry__delete-btn"
										title="Delete this price"
										onClick={(e) => {
											e.stopPropagation();
											setConfirmDelete(price);
										}}
									>
										<TrashIcon />
									</button>
								</div>
							</div>
						);
					})}
				</div>
			)}

			{editing && createPortal(
				<div className="modal-overlay" onClick={() => !saving && setEditing(null)}>
					<div className="modal-card modal-card--wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
						<PriceForm
							key={editing._id || "new"}
							price={editing}
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
					title="Delete this price?"
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
					title="Overwrite Pricing"
					message={`A pricing structure for "${pendingOverwrite.existingPrice.name || serviceLabel(pendingOverwrite.existingPrice.keys)}" already exists. Overwrite the existing price with this new rate?`}
					confirmLabel="Overwrite Pricing"
					cancelLabel="Cancel"
					onConfirm={handleConfirmOverwrite}
					onCancel={() => setPendingOverwrite(null)}
				/>,
				document.body
			)}
		</div>
	);
}

export default PricingSettings;
