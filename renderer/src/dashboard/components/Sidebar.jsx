import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
	HomeIcon,
	PrintJobsIcon,
	HistoryIcon,
	SettingsIcon,
	LogoutIcon,
} from "../icons";
import WhatsAppStatusButton from "./WhatsAppStatusButton";
import AutoPrintSwitcher from "./AutoPrintSwitcher";
import ConfirmDialog from "./ConfirmDialog";

// Printers and Services live under Settings, so they aren't top-level tabs.
const TABS = [
	{ to: "jobs", label: "Jobs", Icon: PrintJobsIcon },
	{ to: "history", label: "History", Icon: HistoryIcon },
];

// Left vertical navigation (WhatsApp-style). Each item is a router NavLink so the state follows the URL.
function Sidebar({ onLogout }) {
	const location = useLocation();
	const [confirmingLogout, setConfirmingLogout] = useState(false);
	// Settings → WhatsApp highlights the WhatsApp shortcut instead.
	const isSettingsActive =
		(location.pathname.includes("settings") && !location.search.includes("section=whatsapp")) ||
		location.pathname.includes("profile");

	return (
		<nav className="db-sidebar">
			<div className="db-sidebar__top">
				{/* Its own header-height block, so the rule under it lines up with the
				    list columns' header rules (Jobs, History…). */}
				<div className="db-sidebar__home">
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

			{/* Bottom utility icons */}
			<div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "auto", width: "100%", alignItems: "center" }}>
				{/* ── Automated-printing toggle ── */}
				<AutoPrintSwitcher />

				{/* ── WhatsApp link status (shortcut to Settings → WhatsApp) ── */}
				<WhatsAppStatusButton />

				{/* ── Settings tab (placed right above Logout) ── */}
				<div className="tooltip-wrapper">
					<NavLink
						to="settings"
						className={`db-tab ${isSettingsActive ? "db-tab--active" : ""}`}
					>
						<span className="db-tab__icon">
							<SettingsIcon />
						</span>
					</NavLink>
					<span className="tooltip-text">Settings</span>
				</div>

				{/* Full-width rule setting Logout apart, like the one under Dashboard. */}
				<div className="db-sidebar__divider" aria-hidden="true" />

				<div className="tooltip-wrapper">
					<button type="button" className="db-tab" onClick={() => setConfirmingLogout(true)} aria-label="Log out">
						<span className="db-tab__icon" style={{ color: "var(--color-accent)" }}>
							<LogoutIcon />
						</span>
					</button>
					<span className="tooltip-text">Logout</span>
				</div>
			</div>

			{confirmingLogout && (
				<ConfirmDialog
					title="Log out?"
					message="You'll need to sign in again to receive and print jobs."
					confirmLabel="Log out"
					tone="danger"
					onConfirm={() => {
						setConfirmingLogout(false);
						onLogout?.();
					}}
					onCancel={() => setConfirmingLogout(false)}
				/>
			)}
		</nav>
	);
}

export default Sidebar;
