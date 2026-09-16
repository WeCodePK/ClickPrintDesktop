import { useState, useEffect, useCallback, useMemo } from "react";
import { WalletIcon } from "../../icons";

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

// ── Validation Helpers ────────────────────────────────────────────────────────

// Validates bank or mobile wallet provider name (2-50 chars, allowed punctuation, start & end alphanumeric)
function validateBankName(name) {
	const trimmed = (name || "").trim();
	if (!trimmed) return "Bank or wallet provider name is required.";
	if (trimmed.length < 2) return "Bank name must be at least 2 characters.";
	if (trimmed.length > 50) return "Bank name cannot exceed 50 characters.";
	if (!/^[\p{L}\p{N}\s.,'&()\-]+$/u.test(trimmed)) {
		return "Bank name contains invalid characters.";
	}
	if (!/[\p{L}\p{N}]/u.test(trimmed)) {
		return "Bank name must contain at least one letter or digit.";
	}
	if (!/^[\p{L}\p{N}].*[\p{L}\p{N}]$|^[\p{L}\p{N}]$/u.test(trimmed)) {
		return "Bank name must start and end with a letter or digit.";
	}
	if (/([.,'&()\-])\1/.test(trimmed)) {
		return "Bank name cannot contain consecutive punctuation marks.";
	}
	return null;
}

// Validates account title (2-100 chars, start alphanumeric, end alphanumeric or '.' or ')')
function validateAccountTitle(title) {
	const trimmed = (title || "").trim();
	if (!trimmed) return "Account title is required.";
	if (trimmed.length < 2) return "Account title must be at least 2 characters.";
	if (trimmed.length > 50) return "Account title cannot exceed 50 characters.";
	if (!/^[\p{L}\p{N}\s.,'&()\-]+$/u.test(trimmed)) {
		return "Account title contains invalid characters.";
	}
	if (!/\p{L}/u.test(trimmed)) {
		return "Account title must contain at least one letter.";
	}
	if (!/^[\p{L}\p{N}]/u.test(trimmed)) {
		return "Account title must start with a letter or digit.";
	}
	if (!/[\p{L}\p{N}.)]$/u.test(trimmed)) {
		return "Account title must end with a letter, digit, dot, or closing parenthesis.";
	}
	if (/([.,'&()\-])\1/.test(trimmed)) {
		return "Account title cannot contain consecutive punctuation marks.";
	}
	return null;
}

// Validates PK IBAN, standard 8-20 digit bank account number, or mobile wallet number
function validateWalletNumber(number) {
	const raw = (number || "").trim();
	if (!raw) return "IBAN or account number is required.";
	const cleaned = raw.replace(/[\s\-]/g, "").toUpperCase().replace(/^\+92(?=3\d{9}$)/, "0");

	if (/^PK/i.test(cleaned)) {
		if (!/^PK\d{2}[A-Z]{4}\d{16}$/.test(cleaned)) {
			return "Invalid Pakistani IBAN format (expected e.g. PK36SCBL0000001123456702, 24 characters).";
		}
		return null;
	}

	if (!/^\d{8,20}$/.test(cleaned)) {
		return "Enter a valid PK IBAN, account number (8-20 digits), or mobile wallet number";
	}
	return null;
}

// Validates Pakistani contact number (mobile or landline)
function validateContactNumber(number) {
	const raw = (number || "").trim();
	if (!raw) return "Contact number is required.";
	const normalizedDigits = raw.replace(/[\s\-()]/g, "").replace(/^\+92/, "0");
	if (!/^0\d{9,10}$/.test(normalizedDigits)) {
		return "Contact number must be a valid Pakistani phone number (e.g. 03XXXXXXXXX).";
	}
	return null;
}

// Validates Google Maps link (optional)
function validateGoogleMapsLink(link) {
	const raw = (link || "").trim();
	if (!raw) return null;
	const isGoogleMap = /^https?:\/\/(www\.)?(google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl\/maps)\/?.*/i.test(
		raw
	);
	if (!isGoogleMap) {
		return "Google Maps link must be a valid Google Maps URL (e.g. https://maps.app.goo.gl/…).";
	}
	return null;
}

// Validates 7-day operating hours
function validateTimings(timings) {
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


// `embedded` drops the page header and the in-form submit button so a host (the
// onboarding flow) can submit via an external `<button form={formId}>`; it gets
// the submit state through `onStatusChange` and is told about a save via `onSaved`.
function ShopProfileSettings({ embedded = false, formId, onStatusChange, onSaved }) {
	const [shopId, setShopId] = useState("");
	const [wallet, setWallet] = useState({
		bank: "",
		title: "",
		number: "",
	});
	const [form, setForm] = useState({
		contactNumber: "",
		googleMapsLink: "",
	});
	const [timings, setTimings] = useState(defaultTimings);

	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState(null);
	const [successMessage, setSuccessMessage] = useState(null);
	const [showSuccessPopup, setShowSuccessPopup] = useState(false);

	// Auto-dismiss success popup on any mouse click or after 3 seconds
	useEffect(() => {
		if (!showSuccessPopup) return;

		const timer = setTimeout(() => {
			setShowSuccessPopup(false);
		}, 3000);

		const handleDismiss = () => {
			setShowSuccessPopup(false);
		};

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

	const loadShop = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await window.electronAPI.fetchShop();
			if (result.success && result.data) {
				const shop = result.data;
				setShopId(shop._id || "");
				setWallet({
					bank: shop.wallet?.bank || "",
					title: shop.wallet?.title || "",
					number: shop.wallet?.number || "",
				});
				setForm({
					contactNumber: shop.contactNumber || "",
					googleMapsLink: shop.googleMapsLink || "",
				});
				setTimings(parseTimings(shop.timings));
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

	const updateWallet = (key, value) => {
		setWallet((prev) => ({ ...prev, [key]: value }));
	};

	const updateForm = (key, value) => {
		setForm((prev) => ({ ...prev, [key]: value }));
	};

	const updateTiming = (index, patch) => {
		setTimings((prev) => prev.map((day, i) => (i === index ? { ...day, ...patch } : day)));
	};

	const copyMondayToAll = () => {
		setTimings((prev) => prev.map(() => ({ ...prev[0] })));
	};

	// Real-time client validations driving submit disabled state and error hint
	const validationError = useMemo(() => {
		if (!shopId && !loading) return "Shop not identified.";

		const bankErr = validateBankName(wallet.bank);
		if (bankErr) return bankErr;

		const titleErr = validateAccountTitle(wallet.title);
		if (titleErr) return titleErr;

		const numberErr = validateWalletNumber(wallet.number);
		if (numberErr) return numberErr;

		const contactErr = validateContactNumber(form.contactNumber);
		if (contactErr) return contactErr;

		const mapErr = validateGoogleMapsLink(form.googleMapsLink);
		if (mapErr) return mapErr;

		const timingsErr = validateTimings(timings);
		if (timingsErr) return timingsErr;

		return null;
	}, [shopId, loading, wallet, form, timings]);

	const canSubmit = !saving && !loading && !validationError;

	useEffect(() => {
		onStatusChange?.({ canSubmit, saving, validationError });
	}, [canSubmit, saving, validationError, onStatusChange]);

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
		const cleanedWalletNumber = wallet.number
			.trim()
			.replace(/[\s\-]/g, "")
			.toUpperCase()
			.replace(/^\+92(?=3\d{9}$)/, "0");

		const payload = {
			wallet: {
				bank: wallet.bank.trim(),
				title: wallet.title.trim(),
				number: cleanedWalletNumber,
			},
			contactNumber: form.contactNumber.trim(),
			timings: timingStrings,
			...(form.googleMapsLink.trim() ? { googleMapsLink: form.googleMapsLink.trim() } : {}),
		};

		try {
			const result = await window.electronAPI.updateShop(shopId, payload);
			if (result.success) {
				if (embedded) {
					onSaved?.();
				} else {
					setSuccessMessage("Shop profile updated successfully.");
					setShowSuccessPopup(true);
				}
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
		const spinner = (
			<div className="db-coming-soon">
				<div className="spinner spinner--dark" />
				<p>Loading shop profile…</p>
			</div>
		);
		return embedded ? spinner : <div className="db-detail__view">{spinner}</div>;
	}

	return (
		<div
			className={embedded ? undefined : "db-detail__view"}
			style={embedded ? undefined : { maxWidth: "780px", margin: "0 auto", padding: "28px" }}
		>
			{/* Page Header */}
			{!embedded && (
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
					Manage your wallet, contact and timings.
				</p>
			</div>
			)}

			<form
				id={formId}
				onSubmit={handleSubmit}
				style={{
					background: "var(--color-bg-card)",
					border: "1px solid var(--border-light)",
					borderRadius: "var(--radius-lg)",
					boxShadow: "var(--shadow-md)",
					padding: "24px 28px",
					display: "flex",
					flexDirection: "column",
					gap: "22px",
				}}
			>
				{error && <div className="form-error">{error}</div>}

				{/* 1. Wallet Section (at the top) */}
				<div
					style={{
						border: "1px solid var(--border-light)",
						borderRadius: "var(--radius-md)",
						padding: "16px 18px",
						background: "var(--color-bg)",
						display: "flex",
						flexDirection: "column",
						gap: "14px",
					}}
				>
					<div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
						<div
							style={{
								width: "34px",
								height: "34px",
								borderRadius: "var(--radius-sm)",
								background: "rgba(0, 217, 163, 0.12)",
								color: "var(--color-primary)",
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								flexShrink: 0,
							}}
						>
							<WalletIcon />
						</div>
						<div>
							<h4 style={{ margin: 0, fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>
								Wallet
							</h4>
							<p style={{ margin: 0, fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "2px" }}>
								Provide your bank account / mobile wallet where your earnings will be deposited.
							</p>
						</div>
					</div>

					{/* Bank / Provider Name */}
					<div className="form-field" style={{ marginBottom: 0 }}>
						<label className="form-label" style={{ fontWeight: 600, fontSize: "13px" }}>
							Bank / Wallet provider
						</label>
						<input
							className="form-input"
							type="text"
							value={wallet.bank}
							onChange={(e) => updateWallet("bank", e.target.value)}
							placeholder="e.g. Meezan Bank, EasyPaisa"
							required
						/>
					</div>

					{/* Account Title & Account/IBAN Number in 2 columns */}
					<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
						<div className="form-field" style={{ marginBottom: 0 }}>
							<label className="form-label" style={{ fontWeight: 600, fontSize: "13px" }}>
								Account title
							</label>
							<input
								className="form-input"
								type="text"
								value={wallet.title}
								onChange={(e) => updateWallet("title", e.target.value)}
								placeholder="e.g. Tehseen Riaz"
								required
							/>
						</div>

						<div className="form-field" style={{ marginBottom: 0 }}>
							<label className="form-label" style={{ fontWeight: 600, fontSize: "13px" }}>
								IBAN / Account number
							</label>
							<input
								className="form-input"
								type="text"
								value={wallet.number}
								onChange={(e) => updateWallet("number", e.target.value)}
								required
								style={{
									textTransform:
										wallet.number.startsWith("PK") || wallet.number.startsWith("pk") ? "uppercase" : "none",
								}}
								placeholder="e.g. 03xxxxxxxx"
							/>
						</div>
					</div>
					<span style={{ fontSize: "11.5px", color: "var(--color-text-muted)" }}>
						Supports 24-character IBAN, 8–20 digit bank account number, or mobile wallet (e.g. 03XXXXXXXXX).
					</span>
				</div>

				{/* 2. Contact Number & Google Maps Link */}
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
						/>
					</div>
				</div>

				{/* 3. Timings */}
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

				{/* 4. Action Bar & Submit */}
				<div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
					{!embedded && (
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
					)}

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
		</div>
	);
}

export default ShopProfileSettings;
