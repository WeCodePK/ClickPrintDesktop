import React, { useState } from "react";

function LoginScreen({ onOtpSent }) {
	const [countryCode] = useState("+92");
	const [phone, setPhone] = useState("");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");

	// Build full number: remove '+' prefix → "923012345678"
	const fullNumber = countryCode.slice(1) + phone;
	const isValidPhone =
		phone.length > 0 &&
		phone.length <= 11 &&
		/^[1-9]\d{7,14}$/.test(fullNumber);

	const handleContinue = async () => {
		if (!isValidPhone || loading) return;

		setError("");
		setLoading(true);

		try {
			// IPC call → main process → API
			const result = await window.electronAPI.sendOtp(fullNumber);

			if (result.success) {
				onOtpSent(fullNumber);
			} else {
				setError(result.message || "Failed to send OTP. Please try again.");
			}
		} catch (err) {
			setError("An unexpected error occurred. Please try again.");
		} finally {
			setLoading(false);
		}
	};

	const handleKeyDown = (e) => {
		if (e.key === "Enter") {
			handleContinue();
		}
	};

	return (
		<div className="screen">
			<div style={{ marginTop: "40px" }}>
				{/* Logo / Brand Mark */}
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: "10px",
						marginBottom: "40px",
					}}
				>
					<div className="logo-container">
						<img src="icon.png" alt="ClickPrint Logo" className="logo-img" />
					</div>
					<div>
						<span
							style={{
								fontSize: "18px",
								fontWeight: "800",
								color: "var(--color-text-primary)",
								letterSpacing: "-0.3px",
							}}
						>
							Click
						</span>
						<span
							style={{
								fontSize: "18px",
								fontWeight: "800",
								color: "var(--color-primary)",
								letterSpacing: "-0.3px",
							}}
						>
							Print
						</span>
					</div>
				</div>

				<h1 className="screen__heading">Let's get started!</h1>
				<p className="screen__subheading">
					Please enter your mobile number to receive a verification code
				</p>

				<div className="input-group">
					<div className="country-code">
						<svg width="20" height="14" viewBox="0 0 30 20" style={{ display: "inline-block", borderRadius: "1px", overflow: "hidden" }}>
							<rect width="30" height="20" fill="#01411C" />
							<rect width="7.5" height="20" fill="#ffffff" />
							<circle cx="18.75" cy="10" r="4.5" fill="#ffffff" />
							<circle cx="19.75" cy="9.25" r="4.25" fill="#01411C" />
							<polygon points="21.5,7.5 22,9 23.5,9 22.25,10 22.75,11.5 21.5,10.5 20.25,11.5 20.75,10 19.5,9 21,9" fill="#ffffff" />
						</svg>
						<span>{countryCode}</span>
					</div>
					<div className="phone-input-wrapper">
						<input
							id="phone-input"
							className="phone-input"
							type="tel"
							placeholder="3012345678"
							value={phone}
							onChange={(e) => {
								// Only allow digits
								const val = e.target.value.replace(/\D/g, "");
								setPhone(val);
								setError("");
							}}
							onKeyDown={handleKeyDown}
							maxLength={11}
							autoFocus
						/>
					</div>
				</div>

				{error && (
					<p
						style={{
							fontSize: "13px",
							color: "var(--color-accent)",
							marginTop: "-16px",
							marginBottom: "16px",
							paddingLeft: "4px",
							animation: "fadeSlideIn 200ms ease",
						}}
					>
						{error}
					</p>
				)}
			</div>

			<button
				id="continue-btn"
				className="btn btn--primary btn--full btn--bottom"
				disabled={!isValidPhone || loading}
				onClick={handleContinue}
			>
				{loading ? (
					<div className="spinner" />
				) : (
					<>
						Continue
						<span className="btn__arrow">→</span>
					</>
				)}
			</button>
		</div>
	);
}

export default LoginScreen;