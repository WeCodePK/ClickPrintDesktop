import { useState } from "react";
import { RefreshIcon } from "../icons";

// Icon-only manual refresh for a list header. `onRefresh` returns a promise; the
// icon spins until it settles, and repeat clicks meanwhile are ignored.
function RefreshButton({ onRefresh, label = "Refresh" }) {
	const [busy, setBusy] = useState(false);

	const refresh = async () => {
		if (busy) return;
		setBusy(true);
		try {
			await onRefresh();
		} catch (err) {
			console.error("[Renderer] refresh failed:", err);
		} finally {
			setBusy(false);
		}
	};

	return (
		<button
			type="button"
			className={`list-refresh-btn ${busy ? "list-refresh-btn--busy" : ""}`}
			onClick={refresh}
			title={label}
			aria-label={label}
			aria-busy={busy}
		>
			<RefreshIcon />
		</button>
	);
}

export default RefreshButton;
