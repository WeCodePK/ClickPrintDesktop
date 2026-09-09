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
				<span className="sms-badge">
					<span className="sms-icon">
						<svg
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
						</svg>
					</span>
					SMS
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