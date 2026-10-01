import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { toastDock } from "./toastDock";

// Bottom-right notice for an automatic update (main/updater.js). It can't be
// dismissed: updates install on their own, and this only says what's happening
// — downloading, waiting for the current print, restarting. Mounted at the app
// root so it shows on every screen.
function UpdateToast() {
	const [status, setStatus] = useState(null);

	// Seed (for a late mount) + live subscription.
	useEffect(() => {
		let active = true;
		window.electronAPI?.getUpdateStatus?.()
			.then((s) => { if (active && s) setStatus(s); })
			.catch(() => {});
		const unsubscribe = window.electronAPI?.onUpdateStatus?.((s) => setStatus(s));
		return () => {
			active = false;
			if (unsubscribe) unsubscribe();
		};
	}, []);

	const content = toastContent(status);
	if (!content) return null;

	return createPortal(
		<div className={`update-toast ${content.warning ? "update-toast--warning" : ""}`} role="status" aria-live="polite">
			{content.progress == null && <span className="update-toast__spinner" aria-hidden="true" />}
			<div className="update-toast__body">
				<span className="update-toast__title">{content.title}</span>
				<span className="update-toast__msg">{content.message}</span>
				{content.progress != null && (
					<div className="update-toast__track">
						<div className="update-toast__bar" style={{ width: `${content.progress}%` }} />
					</div>
				)}
			</div>
		</div>,
		toastDock()
	);
}

function toastContent(status) {
	const v = status?.version ? ` v${status.version}` : "";
	switch (status?.state) {
		case "downloading":
			return {
				title: `Downloading update${v}`,
				message: `${status.percent || 0}% — printing carries on as normal.`,
				progress: status.percent || 0,
			};
		case "waiting":
			return {
				title: `Update${v} ready`,
				message: "Finishing the document that's printing, then ClickPrint restarts to install it. New prints are paused until then.",
			};
		case "installing":
			return {
				title: `Installing update${v}`,
				message: "ClickPrint will restart in a moment and pick up where it left off.",
			};
		case "blocked":
			return {
				title: `Update${v} can't install automatically`,
				message: "ClickPrint is installed for all users, which needs administrator approval. It will install the next time ClickPrint is closed — reinstall it for this user only to get updates automatically.",
				warning: true,
			};
		default:
			return null;
	}
}

export default UpdateToast;
