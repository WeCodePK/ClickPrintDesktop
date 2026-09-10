import { useState, useEffect, useCallback, useMemo } from "react";
import LocationPicker from "./LocationPicker";

const DAYS = [
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
	"Sunday",
];

const defaultTimings = () =>
	DAYS.map((_, index) => ({
		closed: index === 6,
		open: "08:30",
		close: index === 5 ? "14:30" : "17:30",
	}));

function serializeTiming(timing) {
	return timing.closed ? "Closed" : `${timing.open}-${timing.close}`;
}

function parseTimings(timings) {
	const fallback = defaultTimings();
	if (!Array.isArray(timings)) return fallback;

	return fallback.map((day, index) => {
		const raw = timings[index]?.trim();
		if (!raw) return day;
		if (raw.toLowerCase() === "closed") return { ...day, closed: true };

		const [open, close] = raw.split("-");
		if (!open || !close) return day;
		return { closed: false, open, close };
	});
}

/**
 * Validates the entire shop profile according to backend constraints and requirements:
 * 1. Shop name: 2-50 chars, must start with an alphabet, can end with an alphanumeric, allowed punctuation, no double punctuation.
 * 2. Address: 5-100 chars.
 * 3. Coordinates: picked from map, valid latitude [-90, 90] and longitude [-180, 180].
 * 4. Image: shop image must be uploaded and not in an active uploading state.
 * 5. Contact number: valid Pakistani number (11 digits starting with 03 or 10-11 digits landline).
 * 6. Google Maps link: optional, but if provided must be a valid Google Maps URL.
 * 7. Timings: 7 days, open days must have valid open/close times and close after open.
 */
function validateShopProfile({ form, coordinates, imageFileId, isUploading, timings }) {
	// Shop Name
	const trimmedName = form.name.trim();
	if (!trimmedName) return "Shop name is required.";
	if (trimmedName.length < 2) return "Shop name must be at least 2 characters.";
	if (trimmedName.length > 50) return "Shop name cannot exceed 50 characters.";
	if (!/^[a-zA-Z]/u.test(trimmedName)) return "Shop name must start with a letter (A-Z).";
	if (!/[a-zA-Z0-9]$/u.test(trimmedName)) return "Shop name must end with a letter or number.";
	if (!/^[\p{L}\p{N}\s.,'&()\-]+$/u.test(trimmedName)) return "Shop name contains invalid characters.";
	if (/([.,'&()\-])\1/.test(trimmedName)) return "Shop name cannot contain consecutive punctuation marks.";

	// Address
	const trimmedAddress = form.address.trim();
	if (!trimmedAddress) return "Address is required.";
	if (trimmedAddress.length < 5) return "Address must be at least 5 characters.";
	if (trimmedAddress.length > 100) return "Address cannot exceed 100 characters.";

	// Coordinates
	if (!coordinates || !Number.isFinite(coordinates.lat) || !Number.isFinite(coordinates.lng)) {
		return "Please pick a location on the map.";
	}
	if (coordinates.lat < -90 || coordinates.lat > 90 || coordinates.lng < -180 || coordinates.lng > 180) {
		return "Invalid coordinates range.";
	}

	// Image File
	if (isUploading) return "Shop image is uploading. Please wait.";
	if (!imageFileId) return "A shop image is required.";

	// Contact Number
	const trimmedContact = form.contactNumber.trim();
	if (!trimmedContact) return "Contact number is required.";
	const normalizedDigits = trimmedContact.replace(/[\s\-()]/g, "").replace(/^\+92/, "0");
	if (!/^0\d{9,10}$/.test(normalizedDigits)) {
		return "Contact number must be a valid Pakistani phone number (e.g. 03XXXXXXXXX).";
	}

	// Google Maps Link (optional)
	const trimmedMapLink = form.googleMapsLink.trim();
	if (trimmedMapLink) {
		const isGoogleMap = /^https?:\/\/(www\.)?(google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl\/maps)\/?.*/i.test(
			trimmedMapLink
		);
		if (!isGoogleMap) {
			return "Google Maps link must be a valid Google Maps URL (e.g. https://maps.app.goo.gl/…).";
		}
	}

	// Timings
	for (let i = 0; i < timings.length; i++) {
		const day = timings[i];
		if (!day.closed) {
			if (!day.open || !day.close) {
				return `Opening and closing times are required for ${DAYS[i]}.`;
			}
			if (day.open === day.close) {
				return `Closing time cannot be the same as opening time on ${DAYS[i]}.`;
			}
			if (day.open > day.close) {
				return `Closing time must be after opening time on ${DAYS[i]}.`;
			}
		}
	}

	return null;
}

function ShopProfileSettings() {
	const [shopId, setShopId] = useState("");
	const [form, setForm] = useState({
		name: "",
		address: "",
		contactNumber: "",
		googleMapsLink: "",
	});
	const [coordinates, setCoordinates] = useState(null);
	const [timings, setTimings] = useState(defaultTimings);
	const [imageFileId, setImageFileId] = useState("");
	const [imageName, setImageName] = useState("");
	const [imagePreview, setImagePreview] = useState(null);
	const [loadedImageData, setLoadedImageData] = useState(null);
	const [isUploading, setIsUploading] = useState(false);
	const [imageError, setImageError] = useState(null);

	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState(null);
	const [successMessage, setSuccessMessage] = useState(null);
	const [showSuccessPopup, setShowSuccessPopup] = useState(false);
	const [isEnlargedImageOpen, setIsEnlargedImageOpen] = useState(false);

	// Close enlarged image on Escape key
	useEffect(() => {
		if (!isEnlargedImageOpen) return;
		const handleKeyDown = (e) => {
			if (e.key === "Escape") {
				setIsEnlargedImageOpen(false);
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [isEnlargedImageOpen]);

	// Auto-dismiss success popup on any mouse click or after 3 seconds
	useEffect(() => {
		if (!showSuccessPopup) return;

		const timer = setTimeout(() => {
			setShowSuccessPopup(false);
		}, 3000);

		const handleDismiss = () => {
			setShowSuccessPopup(false);
		};

		// 100ms delay so the click that triggered the submit doesn't dismiss it immediately
		const attachTimer = setTimeout(() => {
			window.addEventListener("click", handleDismiss, { capture: true });
			window.addEventListener("keydown", handleDismiss, { capture: true });
		}, 100);

		return () => {
			clearTimeout(timer);
			clearTimeout(attachTimer);
			window.removeEventListener("click", handleDismiss, { capture: true });
			window.removeEventListener("keydown", handleDismiss, { capture: true });
		};
	}, [showSuccessPopup]);

	// Revoke preview object URL when unmounted or changed
	useEffect(() => {
		return () => {
			if (imagePreview) URL.revokeObjectURL(imagePreview);
		};
	}, [imagePreview]);

	// Fetch existing backend image as data URL
	useEffect(() => {
		let active = true;
		if (imageFileId && !imagePreview) {
			window.electronAPI?.fetchImageData?.(imageFileId).then((dataUrl) => {
				if (active && dataUrl) {
					setLoadedImageData(dataUrl);
				}
			});
		} else {
			setLoadedImageData(null);
		}
		return () => {
			active = false;
		};
	}, [imageFileId, imagePreview]);

	const loadShop = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await window.electronAPI.fetchShop();
			if (result.success && result.data) {
				const shop = result.data;
				setShopId(shop._id || "");
				setForm({
					name: shop.name || "",
					address: shop.address || "",
					contactNumber: shop.contactNumber || "",
					googleMapsLink: shop.googleMapsLink || "",
				});
				if (Array.isArray(shop.coordinates) && shop.coordinates.length === 2) {
					setCoordinates({ lat: shop.coordinates[0], lng: shop.coordinates[1] });
				}
				setTimings(parseTimings(shop.timings));
				const imgId = typeof shop.imageFile === "object" ? shop.imageFile?._id : shop.imageFile;
				if (imgId) {
					setImageFileId(imgId);
				}
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

	const updateForm = (key, value) => {
		setForm((prev) => ({ ...prev, [key]: value }));
	};

	const updateTiming = (index, patch) => {
		setTimings((prev) => prev.map((day, i) => (i === index ? { ...day, ...patch } : day)));
	};

	const copyMondayToAll = () => {
		setTimings((prev) => prev.map(() => ({ ...prev[0] })));
	};

	const handleImageChange = async (file) => {
		if (!file) return;

		setIsUploading(true);
		setImageError(null);

		try {
			const buffer = await file.arrayBuffer();
			const result = await window.electronAPI.uploadFile(buffer, file.name);

			if (result?.success && result.data?.file?._id) {
				setImageFileId(result.data.file._id);
				setImageName(file.name);
				setImagePreview((prev) => {
					if (prev) URL.revokeObjectURL(prev);
					return URL.createObjectURL(file);
				});
			} else {
				setImageError(result?.message || result?.error || "Image upload failed");
			}
		} catch (err) {
			console.error("[ShopProfileSettings] image upload error:", err);
			setImageError("Network error during image upload.");
		} finally {
			setIsUploading(false);
		}
	};

	// Resolved image preview source
	const previewSrc = useMemo(() => {
		if (imagePreview) return imagePreview;
		if (loadedImageData) return loadedImageData;
		if (imageFileId && window.electronAPI?.getFileUrl) {
			return window.electronAPI.getFileUrl(imageFileId);
		}
		return null;
	}, [imagePreview, loadedImageData, imageFileId]);

	// Live real-time validation drives submit disabled state and error hint
	const validationError = useMemo(() => {
		if (!shopId && !loading) return "Shop not identified.";
		return validateShopProfile({
			form,
			coordinates,
			imageFileId,
			isUploading,
			timings,
		});
	}, [shopId, loading, form, coordinates, imageFileId, isUploading, timings]);

	const canSubmit = !saving && !isUploading && !validationError;

	const handleSubmit = async (e) => {
		e.preventDefault();
		if (!shopId) {
			setError("Shop ID not identified.");
			return;
		}

		if (validationError) {
			setError(validationError);
			return;
		}

		setSaving(true);
		setError(null);
		setSuccessMessage(null);

		const timingStrings = timings.map(serializeTiming);
		const payload = {
			name: form.name.trim(),
			address: form.address.trim(),
			coordinates: [coordinates.lat, coordinates.lng],
			imageFile: imageFileId,
			contactNumber: form.contactNumber.trim(),
			timings: timingStrings,
			...(form.googleMapsLink.trim() ? { googleMapsLink: form.googleMapsLink.trim() } : {}),
		};

		try {
			const result = await window.electronAPI.updateShop(shopId, payload);
			if (result.success) {
				setSuccessMessage("Shop profile updated successfully.");
				setShowSuccessPopup(true);
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

	return (
		<div className="db-detail__view" style={{ maxWidth: "820px", margin: "0 auto", padding: "28px" }}>
			{/* Page Header */}
			<div style={{ marginBottom: "24px" }}>
				<span
					style={{
						fontSize: "11px",
						fontWeight: 700,
						letterSpacing: "1.2px",
						textTransform: "uppercase",
						color: "var(--color-text-muted)",
					}}
				>
					SHOPS
				</span>
				<h2
					style={{
						fontSize: "26px",
						fontWeight: 700,
						color: "var(--color-text-primary)",
						marginTop: "4px",
						marginBottom: "4px",
					}}
				>
					Shop profile
				</h2>
				<p style={{ fontSize: "13.5px", color: "var(--color-text-secondary)" }}>
					Register or manage your location with address, timings, and contact details.
				</p>
			</div>

			<form
				onSubmit={handleSubmit}
				style={{
					background: "var(--color-bg-card)",
					border: "1px solid var(--border-light)",
					borderRadius: "var(--radius-lg)",
					boxShadow: "var(--shadow-md)",
					padding: "24px 28px",
					display: "flex",
					flexDirection: "column",
					gap: "20px",
				}}
			>
				{error && <div className="form-error">{error}</div>}

				{/* 1. Shop Name */}
				<div className="form-field" style={{ marginBottom: 0 }}>
					<label className="form-label" style={{ fontWeight: 600, fontSize: "13px" }}>
						Shop name
					</label>
					<input
						className="form-input"
						type="text"
						value={form.name}
						onChange={(e) => updateForm("name", e.target.value)}
						placeholder="Building or block name"
						required
					/>
				</div>

				{/* 2. Address */}
				<div className="form-field" style={{ marginBottom: 0 }}>
					<label className="form-label" style={{ fontWeight: 600, fontSize: "13px" }}>
						Address
					</label>
					<input
						className="form-input"
						type="text"
						value={form.address}
						onChange={(e) => updateForm("address", e.target.value)}
						placeholder="Street, area, city"
						required
					/>
				</div>

				{/* 3. Location Section */}
				<div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
					<div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: "8px" }}>
						<label className="form-label" style={{ fontWeight: 600, fontSize: "13px", margin: 0 }}>
							Location
						</label>
						<span style={{ fontSize: "12px", color: "var(--color-text-muted)" }}>
							Click the map to drop a pin, or drag it to fine-tune
						</span>
					</div>

					{/* Leaflet Map with Search Bar */}
					<LocationPicker value={coordinates} onChange={setCoordinates} />

					{/* Coordinates: Disabled / Auto-filled */}
					<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginTop: "4px" }}>
						<div>
							<span style={{ fontSize: "11.5px", color: "var(--color-text-muted)", display: "block", marginBottom: "4px" }}>
								Latitude
							</span>
							<input
								className="form-input"
								type="text"
								value={coordinates?.lat !== undefined && coordinates?.lat !== null ? coordinates.lat.toFixed(5) : ""}
								placeholder="00.00000"
								disabled
								readOnly
								style={{
									backgroundColor: "var(--color-bg-input)",
									cursor: "not-allowed",
									opacity: 0.8,
									fontFamily: "monospace",
								}}
							/>
						</div>
						<div>
							<span style={{ fontSize: "11.5px", color: "var(--color-text-muted)", display: "block", marginBottom: "4px" }}>
								Longitude
							</span>
							<input
								className="form-input"
								type="text"
								value={coordinates?.lng !== undefined && coordinates?.lng !== null ? coordinates.lng.toFixed(5) : ""}
								placeholder="00.00000"
								disabled
								readOnly
								style={{
									backgroundColor: "var(--color-bg-input)",
									cursor: "not-allowed",
									opacity: 0.8,
									fontFamily: "monospace",
								}}
							/>
						</div>
					</div>
				</div>

				{/* 4. Shop Image */}
				<div className="form-field" style={{ marginBottom: 0 }}>
					<label className="form-label" style={{ fontWeight: 600, fontSize: "13px" }}>
						Shop image
					</label>
					<div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap", marginTop: "4px" }}>
						<input
							type="file"
							accept="image/*"
							disabled={isUploading}
							onChange={(e) => handleImageChange(e.target.files?.[0] || null)}
							style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}
						/>
						{previewSrc && (
							<div
								onClick={() => setIsEnlargedImageOpen(true)}
								style={{
									position: "relative",
									cursor: "pointer",
									display: "inline-block",
								}}
								title="Click to enlarge image"
							>
								<img
									src={previewSrc}
									alt={imageName || form.name || "Shop preview"}
									style={{
										width: "50px",
										height: "50px",
										borderRadius: "var(--radius-md)",
										border: "1px solid var(--border-light)",
										objectFit: "cover",
										display: "block",
										transition: "transform var(--transition-fast), box-shadow var(--transition-fast)",
									}}
									onMouseEnter={(e) => {
										e.currentTarget.style.transform = "scale(1.08)";
										e.currentTarget.style.boxShadow = "var(--shadow-md)";
									}}
									onMouseLeave={(e) => {
										e.currentTarget.style.transform = "scale(1)";
										e.currentTarget.style.boxShadow = "none";
									}}
								/>
								<div
									style={{
										position: "absolute",
										bottom: "2px",
										right: "2px",
										background: "rgba(0, 0, 0, 0.65)",
										borderRadius: "50%",
										width: "16px",
										height: "16px",
										display: "flex",
										alignItems: "center",
										justifyContent: "center",
										color: "#fff",
										fontSize: "9px",
										pointerEvents: "none",
									}}
								>
									🔍
								</div>
							</div>
						)}
					</div>
					<div style={{ fontSize: "11.5px", color: "var(--color-text-muted)", marginTop: "6px" }}>
						{isUploading
							? "Uploading image…"
							: imageName
							? `Selected: ${imageName}`
							: imageFileId
							? "Choose a file to replace the current image"
							: "Please select an image for your shop"}
						{previewSrc && !isUploading && (
							<span
								onClick={() => setIsEnlargedImageOpen(true)}
								style={{
									marginLeft: "8px",
									color: "var(--color-primary)",
									cursor: "pointer",
									fontWeight: 600,
								}}
							>
								(Click to view full image)
							</span>
						)}
					</div>
					{imageError && <div style={{ fontSize: "11.5px", color: "var(--color-accent)", marginTop: "4px" }}>{imageError}</div>}
				</div>

				{/* 5. Contact Number & Google Maps Link */}
				<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
					<div className="form-field" style={{ marginBottom: 0 }}>
						<label className="form-label" style={{ fontWeight: 600, fontSize: "13px" }}>
							Contact number
						</label>
						<input
							className="form-input"
							type="text"
							value={form.contactNumber}
							onChange={(e) => updateForm("contactNumber", e.target.value)}
							placeholder="03XXXXXXXXX"
							required
						/>
					</div>

					<div className="form-field" style={{ marginBottom: 0 }}>
						<label className="form-label" style={{ fontWeight: 600, fontSize: "13px" }}>
							Google Maps link <span style={{ fontWeight: 400, color: "var(--color-text-muted)" }}>(optional)</span>
						</label>
						<input
							className="form-input"
							type="url"
							value={form.googleMapsLink}
							onChange={(e) => updateForm("googleMapsLink", e.target.value)}
							placeholder="https://maps.app.goo.gl/…"
						/>
					</div>
				</div>

				{/* 6. Timings */}
				<div>
					<div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "8px" }}>
						<label className="form-label" style={{ fontWeight: 600, fontSize: "13px", margin: 0 }}>
							Timings
						</label>
						<button
							type="button"
							onClick={copyMondayToAll}
							style={{
								background: "none",
								border: "none",
								color: "var(--color-primary)",
								fontSize: "12.5px",
								fontWeight: 600,
								cursor: "pointer",
								textDecoration: "none",
								padding: 0,
							}}
							onMouseEnter={(e) => {
								e.currentTarget.style.textDecoration = "underline";
							}}
							onMouseLeave={(e) => {
								e.currentTarget.style.textDecoration = "none";
							}}
						>
							Apply Monday to all days
						</button>
					</div>

					{/* 7-day timing list */}
					<div
						style={{
							borderRadius: "var(--radius-md)",
							border: "1px solid var(--border-light)",
							overflow: "hidden",
							background: "var(--color-bg)",
						}}
					>
						{timings.map((day, index) => (
							<div
								key={DAYS[index]}
								style={{
									display: "flex",
									alignItems: "center",
									flexWrap: "wrap",
									gap: "12px",
									padding: "10px 14px",
									borderBottom: index < 6 ? "1px solid var(--border-light)" : "none",
									background: day.closed ? "var(--color-bg-card)" : "transparent",
									opacity: day.closed ? 0.7 : 1,
									transition: "opacity var(--transition-fast)",
								}}
							>
								{/* Day Name */}
								<span
									style={{
										width: "90px",
										fontSize: "13px",
										fontWeight: 600,
										color: day.closed ? "var(--color-text-muted)" : "var(--color-text-primary)",
									}}
								>
									{DAYS[index]}
								</span>

								{/* Open Time */}
								<input
									type="time"
									className="form-input"
									value={day.open}
									disabled={day.closed}
									onChange={(e) => updateTiming(index, { open: e.target.value })}
									style={{
										width: "120px",
										padding: "6px 10px",
										fontSize: "13px",
										background: "var(--color-bg-card)",
										cursor: day.closed ? "not-allowed" : "text",
									}}
								/>

								<span style={{ fontSize: "12.5px", color: "var(--color-text-muted)" }}>to</span>

								{/* Close Time */}
								<input
									type="time"
									className="form-input"
									value={day.close}
									disabled={day.closed}
									onChange={(e) => updateTiming(index, { close: e.target.value })}
									style={{
										width: "120px",
										padding: "6px 10px",
										fontSize: "13px",
										background: "var(--color-bg-card)",
										cursor: day.closed ? "not-allowed" : "text",
									}}
								/>

								{/* Closed Checkbox */}
								<label
									style={{
										marginLeft: "auto",
										display: "flex",
										alignItems: "center",
										gap: "6px",
										fontSize: "12.5px",
										color: "var(--color-text-muted)",
										cursor: "pointer",
										userSelect: "none",
									}}
								>
									<input
										type="checkbox"
										checked={day.closed}
										onChange={(e) => updateTiming(index, { closed: e.target.checked })}
										style={{ cursor: "pointer" }}
									/>
									Closed
								</label>
							</div>
						))}
					</div>
				</div>

				{/* 7. Action Bar & Submit */}
				<div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
					<button
						type="submit"
						className="btn-gradient"
						disabled={!canSubmit}
						style={{
							width: "100%",
							padding: "12px",
							fontSize: "14px",
							fontWeight: 600,
							borderRadius: "var(--radius-md)",
							cursor: canSubmit ? "pointer" : "not-allowed",
							opacity: canSubmit ? 1 : 0.5,
							transition: "all var(--transition-fast)",
						}}
					>
						{saving ? "Saving changes…" : "Save changes"}
					</button>

					{/* Red hint text describing what is wrong when button is disabled */}
					{!saving && validationError && (
						<div
							style={{
								textAlign: "center",
								fontSize: "12px",
								fontWeight: 600,
								color: "var(--color-accent)",
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								gap: "6px",
								padding: "4px 8px",
							}}
						>
							<span>⚠️</span>
							<span>{validationError}</span>
						</div>
					)}
				</div>
			</form>

			{/* Success Popup with Animated Green Checkmark / Tick */}
			{showSuccessPopup && (
				<div
					onClick={() => setShowSuccessPopup(false)}
					style={{
						position: "fixed",
						inset: 0,
						zIndex: 9999,
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						background: "rgba(0, 0, 0, 0.4)",
						backdropFilter: "blur(3px)",
						cursor: "pointer",
						animation: "fadeIn 150ms ease-out both",
					}}
				>
					<div
						onClick={(e) => {
							// Click directly on the card also dismisses
							setShowSuccessPopup(false);
						}}
						style={{
							background: "var(--color-bg-card)",
							border: "1px solid var(--border-light)",
							borderRadius: "var(--radius-xl)",
							boxShadow: "0 20px 48px rgba(0, 0, 0, 0.3)",
							padding: "36px 44px",
							display: "flex",
							flexDirection: "column",
							alignItems: "center",
							gap: "12px",
							minWidth: "290px",
							maxWidth: "380px",
							textAlign: "center",
							animation: "popIn 300ms cubic-bezier(0.16, 1, 0.3, 1) both",
							cursor: "pointer",
						}}
					>
						{/* Green circle with checkmark/tick icon */}
						<div
							style={{
								width: "64px",
								height: "64px",
								borderRadius: "50%",
								background: "var(--color-primary)",
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								boxShadow: "0 8px 24px rgba(0, 217, 163, 0.35)",
								marginBottom: "4px",
							}}
						>
							<svg
								width="36"
								height="36"
								viewBox="0 0 24 24"
								fill="none"
								stroke="#ffffff"
								strokeWidth="3.2"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<polyline points="20 6 9 17 4 12" />
							</svg>
						</div>

						<h3
							style={{
								fontSize: "19px",
								fontWeight: 700,
								color: "var(--color-text-primary)",
								margin: 0,
							}}
						>
							Updated!
						</h3>

						<p
							style={{
								fontSize: "13.5px",
								color: "var(--color-text-secondary)",
								margin: 0,
								lineHeight: 1.4,
							}}
						>
							{successMessage || "Shop profile updated successfully."}
						</p>

						<span
							style={{
								fontSize: "11px",
								color: "var(--color-text-muted)",
								marginTop: "4px",
							}}
						>
							Click anywhere to dismiss
						</span>
					</div>
				</div>
			)}

			{/* Enlarged Shop Image Lightbox Modal */}
			{isEnlargedImageOpen && previewSrc && (
				<div
					onClick={() => setIsEnlargedImageOpen(false)}
					style={{
						position: "fixed",
						inset: 0,
						zIndex: 10000,
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						background: "rgba(0, 0, 0, 0.78)",
						backdropFilter: "blur(6px)",
						cursor: "zoom-out",
						animation: "fadeIn 180ms ease-out both",
						padding: "32px",
					}}
				>
					<div
						onClick={(e) => e.stopPropagation()}
						style={{
							position: "relative",
							maxWidth: "90vw",
							maxHeight: "88vh",
							display: "flex",
							flexDirection: "column",
							alignItems: "center",
							justifyContent: "center",
							cursor: "default",
							animation: "popIn 260ms cubic-bezier(0.16, 1, 0.3, 1) both",
						}}
					>
						{/* Close Button */}
						<button
							type="button"
							onClick={() => setIsEnlargedImageOpen(false)}
							style={{
								position: "absolute",
								top: "-16px",
								right: "-16px",
								width: "36px",
								height: "36px",
								borderRadius: "50%",
								background: "var(--color-bg-card)",
								border: "1px solid var(--border-light)",
								color: "var(--color-text-primary)",
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								fontSize: "16px",
								fontWeight: 700,
								cursor: "pointer",
								boxShadow: "0 4px 16px rgba(0, 0, 0, 0.4)",
								zIndex: 1,
								transition: "transform var(--transition-fast)",
							}}
							onMouseEnter={(e) => {
								e.currentTarget.style.transform = "scale(1.1)";
							}}
							onMouseLeave={(e) => {
								e.currentTarget.style.transform = "scale(1)";
							}}
							title="Close image preview"
						>
							✕
						</button>

						{/* Enlarged Image */}
						<img
							src={previewSrc}
							alt={imageName || form.name || "Enlarged shop preview"}
							style={{
								maxWidth: "100%",
								maxHeight: "82vh",
								borderRadius: "var(--radius-lg)",
								boxShadow: "0 24px 60px rgba(0, 0, 0, 0.5)",
								border: "1px solid rgba(255, 255, 255, 0.15)",
								objectFit: "contain",
								background: "var(--color-bg-card)",
							}}
						/>

						{/* Caption & Instructions */}
						<div
							style={{
								marginTop: "12px",
								fontSize: "12.5px",
								color: "#ffffff",
								opacity: 0.9,
								textAlign: "center",
								textShadow: "0 1px 3px rgba(0,0,0,0.8)",
							}}
						>
							{imageName || form.name || "Shop Image"} • Click anywhere outside or press Esc to close
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

export default ShopProfileSettings;
