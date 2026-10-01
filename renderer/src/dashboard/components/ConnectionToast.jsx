import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { toastDock } from "../../components/toastDock";

// How long the jobs stream may be down before the toast appears — rides out the
// normal connect at startup and momentary blips without flashing.
const SHOW_AFTER_MS = 1500;

// Bottom-right notice while the live jobs connection (SSE) is down. It can't be
// dismissed: it spins until the connection is back, then disappears on its own.
function ConnectionToast() {
	const [status, setStatus] = useState(null);
	const [visible, setVisible] = useState(false);
	// Whether this session has been connected at all — "reconnecting" vs the
	// first connect after launch.
	const wasOpen = useRef(false);

	useEffect(() => {
		let active = true;
		window.electronAPI?.getSseStatus?.()
			.then((s) => { if (active && s) setStatus(s); })
			.catch(() => {});
		const unsubscribe = window.electronAPI?.onSseStatus?.((s) => setStatus(s));
		return () => {
			active = false;
			if (unsubscribe) unsubscribe();
		};
	}, []);

	useEffect(() => {
		if (status === null) return;
		if (status === "open") {
			wasOpen.current = true;
			setVisible(false);
			return;
		}
		const timer = setTimeout(() => setVisible(true), SHOW_AFTER_MS);
		return () => clearTimeout(timer);
	}, [status]);

	if (!visible) return null;
	return createPortal(
		<div className="conn-toast" role="status" aria-live="polite">
			<span className="conn-toast__spinner" aria-hidden="true" />
			<span className="conn-toast__msg">
				{wasOpen.current ? "Connection lost. Reconnecting…" : "Connecting to ClickPrint…"}
			</span>
		</div>,
		toastDock()
	);
}

export default ConnectionToast;
