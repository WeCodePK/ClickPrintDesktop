import React from "react";
import ListColumn from "../components/ListColumn";
import WelcomePane from "../components/WelcomePane";

// Generic "to be completed" tab used for the Dashboard and Settings views until
// their real content is built.
function PlaceholderTab({ title, description }) {
	return (
		<>
			<ListColumn title={title}>
				<div className="db-coming-soon">
					<span className="db-coming-soon__icon">🛠️</span>
					<p style={{ fontWeight: "600", color: "var(--color-text-primary)", fontSize: "14px" }}>To be completed</p>
					<p style={{ fontSize: "11.5px", color: "var(--color-text-secondary)", textAlign: "center", padding: "0 16px", lineHeight: "1.4" }}>
						{description}
					</p>
				</div>
			</ListColumn>

			<div className="db-detail">
				<WelcomePane />
			</div>
		</>
	);
}

export default PlaceholderTab;
