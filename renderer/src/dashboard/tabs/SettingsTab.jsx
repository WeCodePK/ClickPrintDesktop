import React, { useState, useEffect, useCallback } from "react";
import ListColumn from "../components/ListColumn";
import ConfirmDialog from "../components/ConfirmDialog";
import { TrashIcon } from "../icons";

const PAGE_TYPES = ["A4", "A5", "A3", "Letter", "Legal"];

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

// Create / edit form for a single price. Remounted (keyed) per selection so the
// fields reset cleanly.
function PriceForm({ price, saving, onSave, onDelete }) {
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
		<form className="db-detail__view price-form" onSubmit={submit}>
			<h3 className="db-detail__title">{isNew ? "New Price" : "Edit Price"}</h3>

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
				<button type="submit" className="btn-gradient" disabled={saving}>
					{saving ? "Saving…" : isNew ? "Create Price" : "Save Changes"}
				</button>
			</div>
		</form>
	);
}

// Settings tab — manages the shop's print pricing (CRUD).
function SettingsTab() {
	const [prices, setPrices] = useState([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(null);
	const [selected, setSelected] = useState(null); // price object, or { keys: {} } for new
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
			const result = selected._id
				? await window.electronAPI.updatePrice(selected._id, data)
				: await window.electronAPI.createPrice(data);
			if (result.success) {
				await loadPrices();
				setSelected(null);
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
				setSelected(null);
			} else {
				setError(result.message || "Failed to delete price.");
			}
		} finally {
			setSaving(false);
		}
	};

	return (
		<>
			<ListColumn
				title="Pricing"
				action={
					<button className="db-list__add" onClick={() => setSelected({ keys: {} })}>
						+ New
					</button>
				}
			>
				{loading ? (
					<div className="db-coming-soon">
						<div className="spinner spinner--dark" />
						<p>Loading prices…</p>
					</div>
				) : prices.length === 0 ? (
					<div className="db-coming-soon">
						<p>No prices yet</p>
						<p style={{ fontSize: "11.5px", color: "var(--color-text-secondary)" }}>
							Add your first print price to get started.
						</p>
					</div>
				) : (
					prices.map((price) => (
						<button
							key={price._id}
							className={`db-entry db-entry--price ${selected?._id === price._id ? "db-entry--active" : ""}`}
							onClick={() => setSelected(price)}
						>
							<div className="db-entry__info">
								<span className="db-entry__name">{price.name}</span>
								<span className="db-entry__meta">
									{price.keys?.pageType} · {price.keys?.colored ? "Color" : "B&W"} · {price.keys?.sidedness ? "Double" : "Single"}
								</span>
							</div>
							<span className="db-entry__price">Rs. {price.rate}</span>
						</button>
					))
				)}
			</ListColumn>

			<div className="db-detail">
				{error && <div className="form-error">{error}</div>}
				{selected ? (
					<PriceForm
						key={selected._id || "new"}
						price={selected}
						saving={saving}
						onSave={handleSave}
						onDelete={(p) => setConfirmDelete(p)}
					/>
				) : (
					<div className="db-detail__empty">
						<p>Select a price to edit, or create a new one.</p>
					</div>
				)}
			</div>

			{confirmDelete && (
				<ConfirmDialog
					title="Delete this price?"
					message={`Are you sure you want to delete "${confirmDelete.name}"? This cannot be undone.`}
					confirmLabel="Delete"
					cancelLabel="Cancel"
					danger
					onConfirm={() => handleDelete(confirmDelete)}
					onCancel={() => setConfirmDelete(null)}
				/>
			)}
		</>
	);
}

export default SettingsTab;
