import { useState, useEffect, useRef } from "react";
import { CheckIcon } from "../icons";

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
 * Sidebar item next to Settings/Logout that (1) shows the live status of the
 * jobs SSE stream — a spinner while connecting/reconnecting so the operator
 * knows there's a problem — and (2) on click reveals the current shop plus any
 * other shops the user owns, letting them switch without re-authenticating.
 */
function ConnectionSwitcher() {
	const [status, setStatus] = useState("closed");
	const [shops, setShops] = useState([]);
	const [currentId, setCurrentId] = useState(null);
	const [currentName, setCurrentName] = useState("");
	const [open, setOpen] = useState(false);
	const [switchingId, setSwitchingId] = useState(null);
	const [error, setError] = useState("");
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

	// Load the current shop + the list to switch between.
	useEffect(() => {
		let active = true;
		window.electronAPI?.getAuthState?.()
			.then((auth) => {
				if (!active || !auth) return;
				setShops(Array.isArray(auth.shops) ? auth.shops : []);
				setCurrentId(auth.shopId ?? null);
				setCurrentName(auth.shopName ?? "");
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

	const handleSwitch = async (shop) => {
		if (switchingId || shop._id === currentId) return;
		setError("");
		setSwitchingId(shop._id);
		try {
			const result = await window.electronAPI.switchShop(shop);
			if (result?.success) {
				setCurrentId(shop._id);
				setCurrentName(shop.name ?? "");
				setOpen(false);
			} else {
				setError(result?.message || "Couldn't switch shop. Please try again.");
			}
		} catch (err) {
			setError("An unexpected error occurred. Please try again.");
		} finally {
			setSwitchingId(null);
		}
	};

	const otherShops = shops.filter((s) => s._id !== currentId);

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

					<div className="conn-popover__section-title">Current shop</div>
					<div className="conn-shop conn-shop--current">
						<span className="conn-shop__avatar">
							{(currentName || "?").trim().charAt(0).toUpperCase()}
						</span>
						<span className="conn-shop__name">{currentName || "Unnamed shop"}</span>
						<span className="conn-shop__check"><CheckIcon /></span>
					</div>

					{otherShops.length > 0 && (
						<>
							<div className="conn-popover__section-title">Switch to</div>
							{otherShops.map((shop) => {
								const busy = switchingId === shop._id;
								return (
									<button
										key={shop._id}
										className="conn-shop conn-shop--option"
										onClick={() => handleSwitch(shop)}
										disabled={!!switchingId}
										id={`conn-shop-${shop._id}`}
									>
										<span className="conn-shop__avatar">
											{(shop.name || "?").trim().charAt(0).toUpperCase()}
										</span>
										<span className="conn-shop__name">{shop.name || "Unnamed shop"}</span>
										{busy && <span className="conn-popover__spinner" />}
									</button>
								);
							})}
						</>
					)}

					{shops.length <= 1 && (
						<div className="conn-popover__empty">You only have one shop.</div>
					)}

					{error && <div className="conn-popover__error">{error}</div>}
				</div>
			)}
		</div>
	);
}

export default ConnectionSwitcher;
