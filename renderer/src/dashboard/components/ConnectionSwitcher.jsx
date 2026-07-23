import { useState, useEffect, useRef } from "react";

// Broadcast/signal glyph for the connection indicator.
const SignalIcon = () => (
	<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
		<path d="M5 12.55a11 11 0 0 1 14 0" />
		<path d="M1.42 9a16 16 0 0 1 21.16 0" />
		<path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
		<line x1="12" y1="20" x2="12.01" y2="20" />
	</svg>
);

// Human-readable description of each SSE connection state.
const STATUS = {
	open:          { label: "Connected",     tone: "ok",   busy: false },
	connecting:    { label: "Connecting…",   tone: "warn", busy: true },
	reconnecting:  { label: "Reconnecting…", tone: "warn", busy: true },
	closed:        { label: "Disconnected",  tone: "off",  busy: false },
};

/**
 * Sidebar item next to Logout that shows the live status of the jobs SSE stream
 * — a spinner while connecting/reconnecting so the operator knows there's a
 * problem. Clicking it reveals the connection state and which shop this session
 * is bound to. Switching shops mid-session is intentionally not offered: to
 * change shops the operator logs out and back in.
 */
function ConnectionSwitcher() {
	const [status, setStatus] = useState("closed");
	const [shopName, setShopName] = useState("");
	const [open, setOpen] = useState(false);
	const wrapRef = useRef(null);

	// Seed status (replay for a late mount) and keep it live.
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

	// Load the shop this session is bound to.
	useEffect(() => {
		let active = true;
		window.electronAPI?.getAuthState?.()
			.then((auth) => {
				if (!active || !auth) return;
				setShopName(auth.shopName ?? "");
			})
			.catch(() => {});
		return () => { active = false; };
	}, []);

	// Close the popover on an outside click or Escape.
	useEffect(() => {
		if (!open) return;
		const onDown = (e) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
		};
		const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	const meta = STATUS[status] || STATUS.closed;

	return (
		<div className="conn-switcher" ref={wrapRef}>
			<button
				className={`db-tab conn-btn ${open ? "db-tab--active" : ""}`}
				onClick={() => setOpen((v) => !v)}
				title={`Connection: ${meta.label}`}
				id="connection-switcher-btn"
			>
				<span className="db-tab__icon">
					<SignalIcon />
				</span>
				{meta.busy ? (
					<span className="conn-btn__spinner" />
				) : (
					<span className={`conn-btn__dot conn-btn__dot--${meta.tone}`} />
				)}
			</button>

			{open && (
				<div className="conn-popover">
					<div className="conn-popover__status">
						{meta.busy ? (
							<span className="conn-popover__spinner" />
						) : (
							<span className={`conn-popover__dot conn-popover__dot--${meta.tone}`} />
						)}
						<div>
							<div className="conn-popover__status-label">Connection</div>
							<div className="conn-popover__status-value">{meta.label}</div>
						</div>
					</div>

					<div className="conn-popover__divider" />

					<div className="conn-popover__section-title">Shop</div>
					<div className="conn-shop conn-shop--current">
						<span className="conn-shop__avatar">
							{(shopName || "?").trim().charAt(0).toUpperCase()}
						</span>
						<span className="conn-shop__name">{shopName || "Unnamed shop"}</span>
					</div>

					<div className="conn-popover__hint">
						To switch shops, log out and sign in again.
					</div>
				</div>
			)}
		</div>
	);
}

export default ConnectionSwitcher;
