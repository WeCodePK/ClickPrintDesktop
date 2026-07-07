import { NavLink } from "react-router-dom";
import {
	HomeIcon,
	PrintJobsIcon,
	PrinterIcon,
	HistoryIcon,
	SettingsIcon,
	LogoutIcon,
} from "../icons";

const TABS = [
	{ to: "jobs", label: "Print Jobs", Icon: PrintJobsIcon },
	{ to: "printers", label: "Printers", Icon: PrinterIcon },
	{ to: "history", label: "History", Icon: HistoryIcon },
];

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
