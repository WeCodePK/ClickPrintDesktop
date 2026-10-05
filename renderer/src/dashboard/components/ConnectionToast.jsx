import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { toastDock } from "../../components/toastDock";
import { useNetStatus, formatSavedAt } from "../useNetStatus";

// How long a problem must last before the toast appears — rides out the normal
// connect at startup and momentary blips without flashing.
const SHOW_AFTER_MS = 1500;

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Bottom-right notice about the connection to ClickPrint. It can't be
// dismissed: it stays while there's something to say and goes on its own.
//   offline            — the backend can't be reached; saved data is showing
//   back, syncing      — online again, updates made offline are going out
//   reconnecting       — online, but the live jobs stream is still coming back
//   session expired    — the server rejected our login; only a new one helps
function ConnectionToast({ onLogout }) {
	const net = useNetStatus();
	const [sse, setSse] = useState(null);
	const [visible, setVisible] = useState(false);
	// Whether the live stream has been connected at all this session.
	const wasOpen = useRef(false);

	useEffect(() => {
		let active = true;
		window.electronAPI?.getSseStatus?.()
			.then((s) => { if (active && s) setSse(s); })
			.catch(() => {});
		const unsubscribe = window.electronAPI?.onSseStatus?.((s) => setSse(s));
		return () => {
			active = false;
			if (unsubscribe) unsubscribe();
		};
	}, []);

	if (sse === "open") wasOpen.current = true;

	let message = null;
	let tone = "danger";
	let action = null;
	if (net.authExpired) {
		message = "Your session has expired. Log in again to keep receiving jobs — nothing printed offline is lost.";
		action = onLogout ? { label: "Log in again", run: onLogout } : null;
	} else if (!net.online) {
		const since = formatSavedAt(net.since);
		message = `Offline${since ? ` since ${since}` : ""} — showing saved data. You can still print by hand.${
			net.pendingSync ? ` ${plural(net.pendingSync, "update")} waiting to sync.` : ""
		}`;
		action = { label: "Retry now", run: () => window.electronAPI.checkConnectionNow?.() };
	} else if (net.pendingSync) {
		tone = "info";
		message = `Back online — syncing ${plural(net.pendingSync, "update")}…`;
	} else if (sse !== null && sse !== "open" && sse !== "closed") {
		message = wasOpen.current ? "Live updates paused. Reconnecting…" : "Connecting to ClickPrint…";
	}

	const showing = !!message;
	useEffect(() => {
		if (!showing) {
			setVisible(false);
			return;
		}
		const timer = setTimeout(() => setVisible(true), SHOW_AFTER_MS);
		return () => clearTimeout(timer);
	}, [showing]);

	if (!visible || !message) return null;
	return createPortal(
		<div className={`conn-toast conn-toast--${tone}`} role="status" aria-live="polite">
			{!net.authExpired && <span className="conn-toast__spinner" aria-hidden="true" />}
			<span className="conn-toast__msg">{message}</span>
			{action && (
				<button type="button" className="btn-outline btn-sm conn-toast__action" onClick={action.run}>
					{action.label}
				</button>
			)}
		</div>,
		toastDock()
	);
}

export default ConnectionToast;
