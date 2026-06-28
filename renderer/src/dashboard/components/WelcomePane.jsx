import React from "react";
import { LockGlyph } from "../icons";

// Default right-hand pane shown when no entry is selected.
function WelcomePane() {
	return (
		<div className="db-welcome">
			<div className="db-welcome__content">
				<div className="db-welcome__logo-container">
					<img src="icon.png" className="db-welcome__logo-img" alt="ClickPrint Logo" />
				</div>
				<h2 className="db-welcome__title">ClickPrint Desktop</h2>
				<p className="db-welcome__subtitle">
					Manage your print shop jobs instantly. Connect your local printers, view job queues, and print sheets seamlessly. Keep the app open to receive new incoming orders.
				</p>
				<div className="db-welcome__divider" />
				<div className="db-welcome__footer">
					<LockGlyph />
					End-to-end secure printing channel
				</div>
			</div>
		</div>
	);
}

export default WelcomePane;
