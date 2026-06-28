import React from "react";

// Lightweight modal confirmation. Clicking the backdrop or Cancel dismisses it.
function ConfirmDialog({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger, onConfirm, onCancel }) {
	return (
		<div className="modal-overlay" onClick={onCancel}>
			<div className="modal-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
				<h3 className="modal-title">{title}</h3>
				<p className="modal-message">{message}</p>
				<div className="modal-actions">
					<button className="btn-outline" onClick={onCancel}>{cancelLabel}</button>
					<button
						className={`btn-gradient ${danger ? "btn-gradient--danger" : ""}`}
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
