import { useState, useEffect, useCallback } from "react";
import { MultiSegmented } from "./Segmented";

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
			const result = await window.electronAPI.fetchShop();
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
					className="service-form"
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

export default ShopProfileSettings;
