import { useState, useRef, useEffect, useCallback } from "react";

function OtpScreen({ phoneNumber, onBack, onVerified }) {
	const [codes, setCodes] = useState(["", "", "", "", ""]);
	const [timer, setTimer] = useState(60);
	const [verifying, setVerifying] = useState(false);
	const [resending, setResending] = useState(false);
	const [showErrorModal, setShowErrorModal] = useState(false);
	const [errorMessage, setErrorMessage] = useState("");
	const [isNotRegistered, setIsNotRegistered] = useState(false);
	const [verified, setVerified] = useState(false);
	const inputRefs = useRef([]);

	useEffect(() => {
		if (timer <= 0) return;
		const interval = setInterval(() => {
			setTimer((prev) => prev - 1);
		}, 1000);
		return () => clearInterval(interval);
	}, [timer]);

	const formattedPhone = phoneNumber
		? `+${phoneNumber.slice(0, 2)} ${phoneNumber.slice(2)}`
		: "";

	const formatTimer = (seconds) => {
		const mins = Math.floor(seconds / 60)
			.toString()
			.padStart(2, "0");
		const secs = (seconds % 60).toString().padStart(2, "0");
		return `${mins}:${secs}`;
	};
	
	const handleCodeChange = useCallback(
		(value, index) => {
			if (value.length > 1) return;
			const newCodes = [...codes];
			newCodes[index] = value;
			setCodes(newCodes);

			if (value && index < 4) {
				inputRefs.current[index + 1]?.focus();
			}

			if (
				newCodes.every((c) => c !== "") &&
				index === 4 &&
				!verifying
			) {
				handleVerify(newCodes.join(""));
			}
		},
		[codes, verifying]
	);

	const handleKeyDown = (e, index) => {
		if (e.key === "Backspace" && !codes[index] && index > 0) {
			inputRefs.current[index - 1]?.focus();
		}
	};

	const handlePaste = (e) => {
		e.preventDefault();
		const pasted = e.clipboardData
			.getData("text")
			.replace(/\D/g, "")
			.slice(0, 5);
		if (pasted.length === 0) return;

		const newCodes = [...codes];
		for (let i = 0; i < 5; i++) {
			newCodes[i] = pasted[i] || "";
		}
		setCodes(newCodes);

		const nextEmpty = newCodes.findIndex((c) => c === "");
		inputRefs.current[nextEmpty === -1 ? 4 : nextEmpty]?.focus();

		if (pasted.length === 5 && !verifying) {
			handleVerify(pasted);
		}
	};

	const handleVerify = async (code) => {
		if (verifying) return;
		setVerifying(true);

		try {
			const result = await window.electronAPI.verifyOtp(code, phoneNumber);

			if (result.success) {
				setVerified(true);
				setTimeout(() => {
					onVerified(result.data);
				}, 1500);
			} else {
				const notRegistered = result.data?.errorCode === 'SHOP_NOT_REGISTERED';
				setIsNotRegistered(notRegistered);
				setErrorMessage(
					result.message || "Invalid code. Please try again."
				);
				setShowErrorModal(true);
			}
		} catch (err) {
			setErrorMessage("An unexpected error occurred. Please try again.");
			setShowErrorModal(true);
		} finally {
			setVerifying(false);
		}
	};

	const handleResend = async () => {
		if (timer > 0 || resending) return;
		setResending(true);

		try {
			const result = await window.electronAPI.sendOtp(phoneNumber);
			if (result.success) {
				setCodes(["", "", "", "", ""]);
				setTimer(60);
				inputRefs.current[0]?.focus();
			} else {
				setErrorMessage(
					result.message || "Failed to resend OTP."
				);
				setShowErrorModal(true);
			}
		} catch (err) {
			setErrorMessage("An unexpected error occurred.");
			setShowErrorModal(true);
		} finally {
			setResending(false);
		}
	};

	const handleClearAndRetry = () => {
		setShowErrorModal(false);
		setIsNotRegistered(false);
		setCodes(["", "", "", "", ""]);
		inputRefs.current[0]?.focus();
	};

	if (verified) {
		return (
			<div className="success-container">
				<div className="success-icon">
					<svg
						width="36"
						height="36"
						viewBox="0 0 24 24"
						fill="none"
						stroke="white"
						strokeWidth="2.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<polyline points="20 6 9 17 4 12" />
					</svg>
				</div>
				<h2 className="success-title">Verified!</h2>
				<p className="success-subtitle">
					You have been successfully authenticated
				</p>
			</div>
		);
	}

	return (
		<div className="screen">
			<button className="back-btn" onClick={onBack} id="back-btn">
				<span className="back-btn__icon">←</span>
				Back
			</button>

			<h1 className="screen__heading">Enter verification code</h1>

			<div className="instruction-row">
				<span className="instruction-text">
					We've sent it to {formattedPhone} via
				</span>
				<span className="whatsapp-badge">
					<span className="whatsapp-icon">
						<svg
							width="17"
							height="17"
							viewBox="0 0 24 24"
							fill="#25D366"
						>
							<path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
						</svg>
					</span>
					WhatsApp
				</span>
			</div>

			<div className="otp-container" onPaste={handlePaste}>
				{codes.map((code, index) => (
					<input
						key={index}
						ref={(el) => (inputRefs.current[index] = el)}
						id={`otp-input-${index}`}
						className={`otp-input ${code ? "filled" : ""}`}
						type="text"
						inputMode="numeric"
						maxLength={1}
						value={code}
						onChange={(e) =>
							handleCodeChange(
								e.target.value.replace(/\D/g, ""),
								index
							)
						}
						onKeyDown={(e) => handleKeyDown(e, index)}
						autoFocus={index === 0}
						disabled={verifying}
					/>
				))}
			</div>

			{verifying && (
				<div
					style={{
						display: "flex",
						justifyContent: "center",
						marginBottom: "16px",
					}}
				>
					<div className="spinner spinner--dark" />
				</div>
			)}

			<div className="timer-section">
				{timer > 0 ? (
					<p className="timer-text">
						Resend available in{" "}
						<strong>{formatTimer(timer)}</strong>
					</p>
				) : (
					<button
						className="resend-btn"
						onClick={handleResend}
						disabled={resending}
						id="resend-btn"
					>
						{resending ? "Sending..." : "Resend code"}
					</button>
				)}
			</div>

			{showErrorModal && (
				<div className="modal-overlay">
					<div className="modal-content">
						<h3 className="modal-title">
							{isNotRegistered ? "Not Registered" : "Oops"}
						</h3>
						<p className="modal-message">{errorMessage}</p>
						<div className="modal-actions">
							{isNotRegistered ? (
								<button
									className="modal-btn--retry"
									onClick={() => {
										setShowErrorModal(false);
										setIsNotRegistered(false);
										onBack();
									}}
									id="modal-try-diff-btn"
								>
									Try different number
									<span>→</span>
								</button>
							) : (
								<>
									<button
										className="modal-btn--cancel"
										onClick={() => setShowErrorModal(false)}
										id="modal-cancel-btn"
									>
										Cancel
										<span>✕</span>
									</button>
									<button
										className="modal-btn--retry"
										onClick={handleClearAndRetry}
										id="modal-retry-btn"
									>
										Try again
										<span>→</span>
									</button>
								</>
							)}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

export default OtpScreen;