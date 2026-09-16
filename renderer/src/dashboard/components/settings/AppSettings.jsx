import { useState, useEffect } from "react";

/**
 * App-level (as opposed to shop-level) preferences.
 *
 * Today that's just the launch-at-sign-in login item. The main process is the
 * source of truth — it reads the real OS setting back after writing it — so the
 * toggle reflects what Windows actually has registered, not what we asked for.
 */
// `embedded` renders just the settings card, without the pane header/padding.
function AppSettings({ embedded = false }) {
	const [openAtLogin, setOpenAtLogin] = useState(false);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState(null);

	useEffect(() => {
		let active = true;
		window.electronAPI?.getOpenAtLogin?.()
			.then((value) => { if (active) setOpenAtLogin(!!value); })
			.catch((err) => {
				console.error("[Renderer] failed to read startup setting:", err);
				if (active) setError("Couldn't read the startup setting.");
			})
			.finally(() => { if (active) setLoading(false); });
		return () => { active = false; };
	}, []);

	const handleToggle = async () => {
		const next = !openAtLogin;
		setSaving(true);
		setError(null);
		// Optimistic — corrected below by whatever the OS actually reports.
		setOpenAtLogin(next);
		try {
			const applied = await window.electronAPI.setOpenAtLogin(next);
			setOpenAtLogin(!!applied);
		} catch (err) {
			console.error("[Renderer] failed to update startup setting:", err);
			setOpenAtLogin(!next);
			setError("Couldn't update the startup setting.");
		} finally {
			setSaving(false);
		}
	};

	const card = (
		<div
			style={{
				width: "100%",
				maxWidth: embedded ? "none" : "600px",
				marginTop: embedded ? 0 : "1.5rem",
				background: "var(--color-bg-card)",
				border: "1px solid var(--border-light)",
				borderRadius: "var(--radius-lg)",
				boxShadow: "var(--shadow-md)",
				padding: "28px",
			}}
		>
			{error && <div className="form-error">{error}</div>}

			<div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
				<div style={{ flex: 1 }}>
					<label className="form-label" style={{ marginBottom: "4px" }}>
						Start ClickPrint when I sign in
					</label>
					<span className="form-hint">
						Launches straight into the system tray after a reboot, so jobs keep
						arriving and printing without anyone opening the app.
					</span>
				</div>
				<button
					type="button"
					className={`toggle ${openAtLogin ? "toggle--on" : ""}`}
					onClick={handleToggle}
					disabled={loading || saving}
					role="switch"
					aria-checked={openAtLogin}
				>
					<span className="toggle__knob" />
				</button>
			</div>

			<div style={{ borderTop: "1px solid var(--border-light)", marginTop: "20px", paddingTop: "20px" }}>
				<label className="form-label" style={{ marginBottom: "4px" }}>Closing the window</label>
				<span className="form-hint">
					Closing ClickPrint minimises it to the system tray instead of quitting —
					printing carries on in the background. To exit completely, right-click
					the tray icon and choose <strong>Exit</strong>.
				</span>
			</div>
		</div>
	);

	if (embedded) return card;

	return (
		<div className="db-detail__view">
			<div className="settings-panel__header">
				<div>
					<h3 className="db-detail__title" style={{ marginBottom: "4px" }}>App Settings</h3>
					<p className="settings-panel__sub">Control how ClickPrint starts and runs on this computer.</p>
				</div>
			</div>

			<div style={{ display: "flex", justifyContent: "center", width: "100%" }}>
				{card}
			</div>
		</div>
	);
}

export default AppSettings;
