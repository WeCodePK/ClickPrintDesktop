import React, { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import ListColumn from "../components/ListColumn";
import ConfirmDialog from "../components/ConfirmDialog";
import { TrashIcon } from "../icons";

const PAGE_TYPES = ["A4", "A5", "A3", "Letter", "Legal"];

// Settings sections shown in the left column. Add more entries here as the
// settings surface grows — each renders its own panel in the right pane.
const SECTIONS = [
	{ id: "pricing", label: "Pricing", description: "Print rates by paper, color & sides" },
];

// Two-state segmented toggle.
function Segmented({ options, value, onChange }) {
	return (
		<div className="segmented">
			{options.map((opt) => (
				<button
					key={String(opt.value)}
					type="button"
					className={`segmented__btn ${value === opt.value ? "segmented__btn--active" : ""}`}
					onClick={() => onChange(opt.value)}
				>
					{opt.label}
				</button>
			))}
		</div>
	);
}

// Create / edit form for a single price, shown inside a modal. Remounted (keyed)
// per selection so the fields reset cleanly.
function PriceForm({ price, saving, onSave, onCancel, onDelete }) {
	const isNew = !price._id;
	const [rate, setRate] = useState(price.rate ?? "");
	const [colored, setColored] = useState(price.keys?.colored ?? false);
	const [pageType, setPageType] = useState(price.keys?.pageType || "A4");
	const [sidedness, setSidedness] = useState(price.keys?.sidedness ?? false);
	const [name, setName] = useState(price.name || "");

	// Conventional name derived from the keys, used as a default if left blank.
	const suggestedName = `${pageType}-${colored ? "CL" : "BW"}-${sidedness ? "DS" : "SS"}`;

	const submit = (e) => {
		e.preventDefault();
		onSave({
			name: name.trim() || suggestedName,
			rate: Number(rate) || 0,
			keys: { colored, pageType, sidedness },
		});
	};

	return (
		<form className="price-form" onSubmit={submit}>
			<h3 className="modal-title">{isNew ? "New Price" : "Edit Price"}</h3>

			<div className="form-field">
				<label className="form-label">Name</label>
				<input
					className="form-input"
					value={name}
					placeholder={suggestedName}
					onChange={(e) => setName(e.target.value)}
				/>
				<span className="form-hint">Leave blank to use “{suggestedName}”.</span>
			</div>

			<div className="form-field">
				<label className="form-label">Rate (Rs. per page)</label>
				<input
					className="form-input"
					type="number"
					min="0"
					step="0.5"
					value={rate}
					placeholder="0"
					onChange={(e) => setRate(e.target.value)}
					required
				/>
			</div>

			<div className="form-field">
				<label className="form-label">Color</label>
				<Segmented
					value={colored}
					onChange={setColored}
					options={[
						{ label: "Black & White", value: false },
						{ label: "Color", value: true },
					]}
				/>
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
				<label className="form-label">Sides</label>
				<Segmented
					value={sidedness}
					onChange={setSidedness}
					options={[
						{ label: "Single-sided", value: false },
						{ label: "Double-sided", value: true },
					]}
				/>
			</div>

			<div className="action-panel">
				{!isNew && (
					<button
						type="button"
						className="btn-outline btn-outline-danger"
						onClick={() => onDelete(price)}
						disabled={saving}
					>
						<TrashIcon />
						Delete
					</button>
				)}
				<button type="button" className="btn-outline" onClick={onCancel} disabled={saving}>
					Cancel
				</button>
				<button type="submit" className="btn-gradient" disabled={saving}>
					{saving ? "Saving…" : isNew ? "Create Price" : "Save Changes"}
				</button>
			</div>
		</form>
	);
}

// Pricing settings panel — the shop's print pricing CRUD, rendered in the right
// detail pane. The price list lives here with a "New Price" action; creating or
// editing opens the form in a modal.
function PricingSettings() {
	const [prices, setPrices] = useState([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(null);
	const [editing, setEditing] = useState(null); // price object, { keys: {} } for new, or null
	const [saving, setSaving] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(null);

	const loadPrices = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await window.electronAPI.fetchPrices();
			if (result.success) setPrices(result.data.prices || []);
			else setError(result.message || "Failed to load prices.");
		} catch (err) {
			console.error("[Renderer] failed to load prices:", err);
			setError("Failed to load prices.");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadPrices();
	}, [loadPrices]);

	const handleSave = async (data) => {
		setSaving(true);
		setError(null);
		try {
			const result = editing._id
				? await window.electronAPI.updatePrice(editing._id, data)
				: await window.electronAPI.createPrice(data);
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

	const handleDelete = async (price) => {
		setConfirmDelete(null);
		setSaving(true);
		setError(null);
		try {
			const result = await window.electronAPI.deletePrice(price._id);
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

			{error && <div className="form-error">{error}</div>}

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
					{prices.map((price) => (
						<button
							key={price._id}
							className="db-entry db-entry--price"
							onClick={() => setEditing(price)}
						>
							<div className="db-entry__info">
								<span className="db-entry__name">{price.name}</span>
								<span className="db-entry__meta">
									{price.keys?.pageType} · {price.keys?.colored ? "Color" : "B&W"} · {price.keys?.sidedness ? "Double" : "Single"}
								</span>
							</div>
							<span className="db-entry__price">Rs. {price.rate}</span>
						</button>
					))}
				</div>
			)}

			{editing && createPortal(
				<div className="modal-overlay" onClick={() => !saving && setEditing(null)}>
					<div className="modal-card modal-card--wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
						<PriceForm
							key={editing._id || "new"}
							price={editing}
							saving={saving}
							onSave={handleSave}
							onCancel={() => setEditing(null)}
							onDelete={(p) => setConfirmDelete(p)}
						/>
					</div>
				</div>,
				document.body
			)}

			{confirmDelete && createPortal(
				<ConfirmDialog
					title="Delete this price?"
					message={`Are you sure you want to delete "${confirmDelete.name}"? This cannot be undone.`}
					confirmLabel="Delete"
					cancelLabel="Cancel"
					danger
					onConfirm={() => handleDelete(confirmDelete)}
					onCancel={() => setConfirmDelete(null)}
				/>,
				document.body
			)}
		</div>
	);
}

// Settings tab — a left column of setting sections; the selected section's
// management UI renders in the right pane.
function SettingsTab() {
	const [section, setSection] = useState("pricing");

	return (
		<>
			<ListColumn title="Settings">
				{SECTIONS.map((s) => (
					<button
						key={s.id}
						className={`db-entry ${section === s.id ? "db-entry--active" : ""}`}
						onClick={() => setSection(s.id)}
					>
						<div className="db-entry__info">
							<span className="db-entry__name">{s.label}</span>
							<span className="db-entry__meta">{s.description}</span>
						</div>
					</button>
				))}
			</ListColumn>

			<div className="db-detail">
				{section === "pricing" ? (
					<PricingSettings />
				) : (
					<div className="db-detail__empty">
						<p>Select a setting to manage.</p>
					</div>
				)}
			</div>
		</>
	);
}

export default SettingsTab;
