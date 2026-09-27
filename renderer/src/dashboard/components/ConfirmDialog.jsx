import { useEffect, useRef } from "react";

// Confirmation popup: a question as the title, one short line of consequence,
// and the buttons in a row — Cancel on the left, the action (named for what it
// does) on the right. `tone` colours the action: "danger" (red) for destructive
// actions, "warning" (yellow) for proceed-with-caution ones, "primary" (green,
// the default) otherwise. Focus starts on Cancel so a stray Enter never fires
// the action, and Esc cancels.
function ConfirmDialog({
	title,
	message,
	confirmLabel = "Confirm",
	cancelLabel = "Cancel",
	tone,
	danger, // legacy alias for tone="danger"
	onConfirm,
	onCancel,
}) {
	const cancelRef = useRef(null);
	const actionTone = tone || (danger ? "danger" : "primary");

	useEffect(() => {
		cancelRef.current?.focus();
		const onKeyDown = (event) => {
			if (event.key === "Escape") onCancel();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onCancel]);

	return (
		<div className="modal-overlay" onClick={onCancel}>
			<div
				className="modal-card"
				onClick={(e) => e.stopPropagation()}
				role="alertdialog"
				aria-modal="true"
				aria-labelledby="confirm-dialog-title"
				aria-describedby={message ? "confirm-dialog-message" : undefined}
			>
				<h3 className="modal-title" id="confirm-dialog-title">{title}</h3>
				{message && <p className="modal-message" id="confirm-dialog-message">{message}</p>}
				<div className="modal-actions modal-actions--row">
					<button ref={cancelRef} className="btn-outline" onClick={onCancel}>
						{cancelLabel}
					</button>
					<button
						className={`btn-gradient ${actionTone !== "primary" ? `btn-gradient--${actionTone}` : ""}`}
						onClick={onConfirm}
					>
						{confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
}

export default ConfirmDialog;
