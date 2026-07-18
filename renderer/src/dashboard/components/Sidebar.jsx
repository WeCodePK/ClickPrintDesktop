import { useState, useEffect } from "react";
import { NavLink } from "react-router-dom";
import {
	HomeIcon,
	PrintJobsIcon,
	PrinterIcon,
	HistoryIcon,
	SettingsIcon,
	LogoutIcon,
} from "../icons";
import ConnectionSwitcher from "./ConnectionSwitcher";

const TABS = [
	{ to: "jobs", label: "Print Jobs", Icon: PrintJobsIcon },
	{ to: "printers", label: "Printers", Icon: PrinterIcon },
	{ to: "history", label: "History", Icon: HistoryIcon },
];

// ── Leaf icon (matches the Claude Code reference) ────────────────────────────
const LeafIcon = () => (
	<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
		<path d="M11 20A7 7 0 0 1 9.8 6.9C15.5 4.9 17 3.5 19 2c1 2 2 4.5 2 8 0 5.5-4.78 10-10 10Z" />
		<path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12" />
	</svg>
);

// ── Arrow-right icon for the relaunch action ─────────────────────────────────
const ArrowRightIcon = () => (
	<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
		<line x1="5" y1="12" x2="19" y2="12" />
		<polyline points="12 5 19 12 12 19" />
	</svg>
);

/**
 * In-sidebar update prompt (Claude-Code style). A slim leaf icon in the sidebar
 * that reveals a flyout on hover: a progress bar while downloading, or a
 * "Relaunch to update" action once the update is ready.
 *
 * The status is fetched on mount (replay) AND kept live via a subscription, so a
 * banner that mounts after login still reflects an update that already
 * downloaded — the one-off event isn't missed.
 */
function UpdateBanner() {
	const [status, setStatus] = useState({ state: "idle", version: null, percent: 0 });

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

	const { state, version, percent = 0 } = status;

	// Only surface meaningful states — idle/checking stay hidden to avoid flicker.
	if (state !== "downloading" && state !== "ready") return null;

	const isReady = state === "ready";
	const relaunch = () => window.electronAPI?.restartToUpdate?.();

	return (
		<div
			className={`update-item ${isReady ? "update-item--ready" : "update-item--downloading"}`}
			onClick={isReady ? relaunch : undefined}
			role={isReady ? "button" : undefined}
			title={isReady ? "Relaunch to update" : "Downloading update…"}
		>
			<span className="update-item__icon">
				<LeafIcon />
			</span>
			<div className="update-flyout">
				{isReady ? (
					<>
						<span className="update-flyout__title">Relaunch to update</span>
						{version && <span className="update-flyout__version">v{version}</span>}
						<span className="update-flyout__arrow">
							<ArrowRightIcon />
						</span>
					</>
				) : (
					<div className="update-flyout__downloading">
						<span className="update-flyout__title">
							Downloading update{version ? ` v${version}` : ""}…
						</span>
						<div className="update-flyout__progress-track">
							<div className="update-flyout__progress-bar" style={{ width: `${percent}%` }} />
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

// Left vertical navigation (WhatsApp-style). Each item is a router NavLink so the state follows the URL.
function Sidebar() {
	return (
		<nav className="db-sidebar">
			<div className="db-sidebar__top">
				<div className="tooltip-wrapper">
					<NavLink
						to="home"
						className={({ isActive }) =>
							`db-sidebar__home-btn ${isActive ? "db-sidebar__home-btn--active" : ""}`
						}
					>
						<HomeIcon />
					</NavLink>
					<span className="tooltip-text">Dashboard</span>
				</div>

				<div className="db-sidebar__nav">
					{TABS.map(({ to, label, Icon }) => (
						<div key={to} className="tooltip-wrapper">
							<NavLink
								to={to}
								className={({ isActive }) => `db-tab ${isActive ? "db-tab--active" : ""}`}
							>
								<span className="db-tab__icon">
									<Icon />
								</span>
							</NavLink>
							<span className="tooltip-text">{label}</span>
						</div>
					))}
				</div>
			</div>

			{/* Bottom settings & logout icon */}
			<div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "auto", width: "100%", alignItems: "center" }}>
				{/* ── Update banner (shown only when an update is available) ── */}
				<UpdateBanner />

				{/* ── SSE connection status + shop switcher ── */}
				<ConnectionSwitcher />

				<div className="tooltip-wrapper">
					<NavLink
						to="settings"
						className={({ isActive }) => `db-tab ${isActive ? "db-tab--active" : ""}`}
					>
						<span className="db-tab__icon">
							<SettingsIcon />
						</span>
					</NavLink>
					<span className="tooltip-text">Settings</span>
				</div>

				<div className="tooltip-wrapper">
					<NavLink
						to="logout"
						className={({ isActive }) => `db-tab ${isActive ? "db-tab--active" : ""}`}
					>
						<span className="db-tab__icon" style={{ color: "var(--color-accent)" }}>
							<LogoutIcon />
						</span>
					</NavLink>
					<span className="tooltip-text">Logout</span>
				</div>
			</div>
		</nav>
	);
}

export default Sidebar;
