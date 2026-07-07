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
	{ id: "profile", label: "Shop Profile", description: "Manage shop name, address & capabilities" },
];

function Segmented({ options, value, onChange }) {
	return (
		<div className="segmented">
			{options.map((opt) => {
				const isActive = value === opt.value;
				const activeClass = opt.activeClass || "segmented__btn--active";
				return (
					<button
						key={String(opt.value)}
						type="button"
						className={`segmented__btn ${isActive ? activeClass : ""}`}
						onClick={() => onChange(opt.value)}
					>
						{opt.label}
					</button>
				);
			})}
		</div>
	);
}

// Multi-select segmented control. Each group must always keep at least one
// option selected — clicking the last remaining active option in the group is
// a no-op (with a tooltip explaining why) rather than letting it deselect.
function MultiSegmented({ options, selectedValues, onChange }) {
	const optionValues = options.map((o) => o.value);
	const selectedInGroup = selectedValues.filter((v) => optionValues.includes(v));

	return (
		<div className="segmented">
			{options.map((opt) => {
				const isActive = selectedValues.includes(opt.value);
				const activeClass = opt.activeClass || "segmented__btn--active";
				const isLocked = isActive && selectedInGroup.length <= 1;
				const toggle = () => {
					if (isActive) {
						if (isLocked) return;
						onChange(selectedValues.filter((v) => v !== opt.value));
					} else {
						onChange([...selectedValues, opt.value]);
					}
				};
				return (
					<button
						key={String(opt.value)}
						type="button"
						className={`segmented__btn ${isActive ? activeClass : ""} ${isLocked ? "segmented__btn--locked" : ""}`}
						onClick={toggle}
						title={isLocked ? "At least one option in this group must stay selected" : undefined}
					>
						{opt.label}
					</button>
				);
			})}
		</div>
	);
}

// Create / edit form for a single price, shown inside a modal. Remounted (keyed)
// per selection so the fields reset cleanly.
function PriceForm({ price, error, saving, onSave, onCancel }) {
	const isNew = !price._id;
	const [rate, setRate] = useState(price.rate ?? "");
	const [colored, setColored] = useState(price.keys?.colored ?? false);
	const [pageType, setPageType] = useState(price.keys?.pageType || "A4");
	const [sidedness, setSidedness] = useState(price.keys?.sidedness ?? false);

	// Conventional name derived from the keys, used as a default if left blank.
	const suggestedName = `${pageType}-${colored ? "CL" : "BW"}-${sidedness ? "DS" : "SS"}`;
	const isRateInvalid = rate === "" || isNaN(Number(rate)) || Number(rate) < 1 || Number(rate) > 50;
	const isSubmitDisabled = saving || isRateInvalid;

	const submit = (e) => {
		e.preventDefault();
		onSave({
			name: suggestedName,
			rate: Number(rate) || 0,
			keys: { colored, pageType, sidedness },
		});
	};

	return (
		<form className="price-form" onSubmit={submit}>
			<h3 className="modal-title">{isNew ? "New Price" : "Edit Price"}</h3>

			{error && <div className="form-error">{error}</div>}

			<div className="form-field">
				<label className="form-label" style={{marginBottom:"1.5rem"}}>Name: {suggestedName}</label>
			</div>

			<div className="form-field">
				<label className="form-label">Rate (Rs. per page)</label>
				<input
					className="form-input"
					type="number"
					min="1"
					max="50"
					step="1"
					value={rate}
					onChange={(e) => setRate(e.target.value)}
					required
				/>
				{isRateInvalid && <span className="form-hint">Enter a rate between Rs. 1 and Rs. 50 per page.</span>}
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
				<label className="form-label">Paper Size</label>
				<select className="form-input" value={pageType} onChange={(e) => setPageType(e.target.value)}>
					{PAGE_TYPES.map((pt) => (
						<option key={pt} value={pt}>{pt}</option>
					))}
				</select>
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

			<div className="action-panel">
				<button type="button" className="btn-outline" onClick={onCancel} disabled={saving}>
					Cancel
				</button>
				<button
					type="submit"
					className="btn-gradient"
					disabled={isSubmitDisabled}
				>
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
	const [pendingOverwrite, setPendingOverwrite] = useState(null);

	useEffect(() => {
		setError(null);
		setPendingOverwrite(null);
	}, [editing]);

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
		if (!editing._id) {
			const existingPrice = prices.find((p) => p.name === data.name);
			if (existingPrice) {
				setPendingOverwrite({ existingPrice, data });
				return;
			}
		}

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

	const handleConfirmOverwrite = async () => {
		if (!pendingOverwrite) return;
		const { existingPrice, data } = pendingOverwrite;
		setPendingOverwrite(null);
		setSaving(true);
		setError(null);
		try {
			const result = await window.electronAPI.updatePrice(existingPrice._id, data);
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
					{prices.map((price) => (
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
								<span className="db-entry__name">{price.name}</span>
								<span className="db-entry__meta">
									{price.keys?.pageType} · {price.keys?.colored ? "Color" : "B&W"} · {price.keys?.sidedness ? "Double" : "Single"}
								</span>
							</div>
							<div className="db-entry__price-actions">
								<span className="db-entry__price">Rs. {price.rate}</span>
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
					))}
				</div>
			)}

			{editing && createPortal(
				<div className="modal-overlay" onClick={() => !saving && setEditing(null)}>
					<div className="modal-card modal-card--wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
						<PriceForm
							key={editing._id || "new"}
							price={editing}
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
					message={`Are you sure you want to delete "${confirmDelete.name}"? This cannot be undone.`}
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
					message={`A pricing structure for "${pendingOverwrite.existingPrice.name}" already exists. Overwrite the existing price with this new rate?`}
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

// Pure validation shared between the real-time "can I submit yet?" check (used
// to disable the button) and the submit handler's final guard. Returns the
// first violated rule's message, or null when the profile is valid.
function validateShopProfile({ name, address, capabilities }) {
	const trimmedName = name.trim();
	const trimmedAddress = address.trim();

	if (!trimmedName) return "Shop Name cannot be empty.";
	if (!trimmedAddress) return "Address cannot be empty.";

	if (trimmedName.length < 5) return "Shop Name must be at least 5 characters long.";
	if (trimmedAddress.length < 10) return "Address must be at least 10 characters long.";

	if (!/[a-zA-Z]/.test(trimmedName)) return "Shop Name cannot consist of numbers only.";
	if (!/[a-zA-Z]/.test(trimmedAddress)) return "Address cannot consist of numbers only.";

	const hasColor = capabilities.some((val) => ["bw", "color"].includes(val));
	const hasPaper = capabilities.some((val) => ["a3", "a4", "a5", "letter", "legal"].includes(val));
	const hasSidedness = capabilities.some((val) => ["single", "double"].includes(val));

	if (!hasColor) return "At least one color capability (Black & White or Color) must be selected.";
	if (!hasPaper) return "At least one paper size capability must be selected.";
	if (!hasSidedness) return "At least one sidedness capability (Single or Double) must be selected.";

	return null;
}

function ShopProfileSettings() {
	const [shopId, setShopId] = useState("");
	const [name, setName] = useState("");
	const [address, setAddress] = useState("");
	const [capabilities, setCapabilities] = useState([]);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState(null);
	const [successMessage, setSuccessMessage] = useState(null);

	const loadShop = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await window.electronAPI.fetchPrices();
			if (result.success && result.data) {
				setShopId(result.data._id || "");
				setName(result.data.name || "");
				setAddress(result.data.address || "");
				setCapabilities(result.data.capabilities || []);
			} else {
				setError(result.message || "Failed to load shop profile.");
			}
		} catch (err) {
			console.error("[Renderer] failed to load shop profile:", err);
			setError("Failed to load shop profile.");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadShop();
	}, [loadShop]);

	const handleSubmit = async (e) => {
		e.preventDefault();
		if (!shopId) {
			setError("Shop ID not identified.");
			return;
		}

		const validationError = validateShopProfile({ name, address, capabilities });
		if (validationError) {
			setError(validationError);
			return;
		}

		setSaving(true);
		setError(null);
		setSuccessMessage(null);
		try {
			const result = await window.electronAPI.updateShop(shopId, {
				name: name.trim(),
				address: address.trim(),
				capabilities,
			});
			if (result.success) {
				setSuccessMessage("Shop profile updated successfully.");
				setTimeout(() => setSuccessMessage(null), 3000);
			} else {
				setError(result.message || "Failed to update shop profile.");
			}
		} catch (err) {
			console.error("[Renderer] failed to update shop:", err);
			setError("Failed to update shop profile.");
		} finally {
			setSaving(false);
		}
	};

	if (loading) {
		return (
			<div className="db-detail__view">
				<div className="db-coming-soon">
					<div className="spinner spinner--dark" />
					<p>Loading shop profile…</p>
				</div>
			</div>
		);
	}

	// Live validation, recomputed on every change, drives the submit button's
	// disabled state so it can't be pressed until the form is actually valid.
	const validationError = shopId ? validateShopProfile({ name, address, capabilities }) : "Shop not identified.";
	const canSubmit = !saving && !validationError;

	return (
		<div className="db-detail__view">
			<div className="settings-panel__header">
				<div>
					<h3 className="db-detail__title" style={{ marginBottom: "4px" }}>Shop Profile</h3>
					<p className="settings-panel__sub">Update your shop name, address, and printing capabilities.</p>
				</div>
			</div>

			<div style={{ display: "flex", justifyContent: "center", width: "100%" }}>
				<form
					className="price-form"
					onSubmit={handleSubmit}
					style={{
						width: "100%",
						maxWidth: "600px",
						marginTop: "1.5rem",
						background: "var(--color-bg-card)",
						border: "1px solid var(--border-light)",
						borderRadius: "var(--radius-lg)",
						boxShadow: "var(--shadow-md)",
						padding: "28px",
					}}
				>
					{error && <div className="form-error">{error}</div>}
					{successMessage && <div className="form-success">{successMessage}</div>}

					<div className="form-field">
						<label className="form-label">Shop Name</label>
						<input
							className="form-input"
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							required
							placeholder="e.g. Ahad Prints"
						/>
					</div>

					<div className="form-field">
						<label className="form-label">Address</label>
						<textarea
							className="form-input"
							style={{ minHeight: "80px", resize: "vertical", fontFamily: "inherit", padding: "0.75rem" }}
							value={address}
							onChange={(e) => setAddress(e.target.value)}
							required
							placeholder="e.g. Westridge, Rawalpindi"
						/>
					</div>

					<div className="form-field">
						<label className="form-label">Color Capabilities</label>
						<MultiSegmented
							selectedValues={capabilities}
							onChange={setCapabilities}
							options={[
								{ label: "Black & White", value: "bw" },
								{ label: "Color", value: "color", activeClass: "segmented__btn--colorful" },
							]}
						/>
					</div>

					<div className="form-field">
						<label className="form-label">Paper Size Capabilities</label>
						<MultiSegmented
							selectedValues={capabilities}
							onChange={setCapabilities}
							options={[
								{ label: "A3", value: "a3" },
								{ label: "A4", value: "a4" },
								{ label: "A5", value: "a5" },
								{ label: "Letter", value: "letter" },
								{ label: "Legal", value: "legal" },
							]}
						/>
					</div>

					<div className="form-field">
						<label className="form-label">Sidedness Capabilities</label>
						<MultiSegmented
							selectedValues={capabilities}
							onChange={setCapabilities}
							options={[
								{ label: "Single", value: "single" },
								{ label: "Double", value: "double" },
							]}
						/>
					</div>

					<div className="action-panel" style={{ marginTop: "2rem", flexDirection: "column", alignItems: "stretch" }}>
						<button type="submit" className="btn-gradient" disabled={!canSubmit}>
							{saving ? "Saving…" : "Save Profile"}
						</button>
						{!saving && validationError && (
							<span className="form-hint" style={{ textAlign: "center", marginTop: "10px", color: "#e64500" }}>
								{validationError}
							</span>
						)}
					</div>
				</form>
			</div>
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
				) : section === "profile" ? (
					<ShopProfileSettings />
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
