import { NavLink, useLocation } from "react-router-dom";
import { WhatsAppIcon } from "../icons";
import { useWhatsAppStatus } from "../whatsappStatus";

/**
 * Sidebar shortcut to Settings → WhatsApp. The status pip shows at a glance
 * whether the shop's WhatsApp is linked; everything else (QR, excluded
 * contacts) lives in the settings section.
 */
function WhatsAppStatusButton() {
	const { meta } = useWhatsAppStatus();
	const location = useLocation();
	const isActive = location.pathname.includes("settings") && location.search.includes("section=whatsapp");

	return (
		<div className="tooltip-wrapper">
			<NavLink
				to="/settings?section=whatsapp"
				className={`db-tab conn-btn ${isActive ? "db-tab--active" : ""}`}
				id="whatsapp-status-btn"
			>
				<span className="db-tab__icon">
					<WhatsAppIcon />
				</span>
				{meta.busy ? (
					<span className="conn-btn__spinner" />
				) : (
					<span className={`conn-btn__dot conn-btn__dot--${meta.tone}`} />
				)}
			</NavLink>
			<span className="tooltip-text">WhatsApp: {meta.label}</span>
		</div>
	);
}

export default WhatsAppStatusButton;
