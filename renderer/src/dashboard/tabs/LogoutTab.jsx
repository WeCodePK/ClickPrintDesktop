import React from "react";
import { useNavigate } from "react-router-dom";

// Logout confirmation. Unlike the other tabs there is no list column — the
// confirmation occupies the right detail pane directly.
function LogoutTab({ onLogout }) {
	const navigate = useNavigate();

	return (
		<div className="db-detail">
			<div className="db-detail__view">
				<h3 className="db-detail__title">Session Logout</h3>
				<div className="printer-status-card" style={{ gap: "20px", padding: "24px" }}>
					<p style={{ fontSize: "14px", color: "var(--color-text-primary)", lineHeight: "1.5" }}>
						Are you sure you want to end your active ClickPrint session and return to the login screen? This will halt any active spools in this desktop instance.
					</p>
					<div className="action-panel">
						<button
							className="btn-outline"
							onClick={() => navigate("/jobs")}
							style={{ flex: 1 }}
						>
							Cancel
						</button>
						<button
							className="btn-gradient"
							style={{
								flex: 1,
								background: "linear-gradient(135deg, var(--color-accent) 0%, var(--color-accent-light) 100%)",
								boxShadow: "var(--shadow-accent)",
								color: "#ffffff"
							}}
							onClick={onLogout}
						>
							Confirm Log Out
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

export default LogoutTab;
