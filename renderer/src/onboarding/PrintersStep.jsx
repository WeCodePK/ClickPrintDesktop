import { useState, useEffect, useCallback } from "react";
import StepLayout from "./StepLayout";
import { PrinterIcon, CheckIcon, RefreshIcon } from "../dashboard/icons";

// Step 1: register at least one of this computer's printers with the shop.
// Already-registered printers show as added; removing them is done from the
// Printers settings section, so this step only ever adds.
function PrintersStep({ onNext, ...layout }) {
	const [registered, setRegistered] = useState([]);
	const [installed, setInstalled] = useState([]);
	const [selected, setSelected] = useState([]);
	const [loading, setLoading] = useState(true);
	const [scanning, setScanning] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState(null);

	const loadRegistered = useCallback(async () => {
		const result = await window.electronAPI.fetchPrinters();
		if (!result?.success) throw new Error(result?.message || "Couldn't load this shop's printers.");
		setRegistered(result.data || []);
	}, []);

	const scan = useCallback(async () => {
		setScanning(true);
		try {
			const result = await window.electronAPI.listAllPrinters(true);
			if (!result?.success) throw new Error(result?.message || "Couldn't find printers on this computer.");
			setInstalled(result.data || []);
		} finally {
			setScanning(false);
		}
	}, []);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			await Promise.all([loadRegistered(), scan()]);
		} catch (err) {
			console.error("[Onboarding] failed to load printers:", err);
			setError(err.message);
		} finally {
			setLoading(false);
		}
	}, [loadRegistered, scan]);

	useEffect(() => {
		load();
	}, [load]);

	const handleRescan = async () => {
		setError(null);
		try {
			await scan();
		} catch (err) {
			setError(err.message);
		}
	};

	const registeredNames = new Set(registered.map((p) => p.name));
	const installedNames = new Set(installed.map((p) => p.name));
	const rows = [
		...installed.map((p) => ({ ...p, added: registeredNames.has(p.name) })),
		// Registered from another computer — shown so the operator knows they exist.
		...registered
			.filter((p) => !installedNames.has(p.name))
			.map((p) => ({ name: p.name, displayName: p.name, added: true, elsewhere: true })),
	];

	const toggle = (name) =>
		setSelected((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));

	const canContinue = registered.length + selected.length > 0;

	const handleNext = async () => {
		if (selected.length === 0) {
			onNext();
			return;
		}
		setSaving(true);
		setError(null);
		try {
			for (const name of selected) {
				const result = await window.electronAPI.createPrinter(name);
				if (!result?.success) throw new Error(result?.message || `Couldn't add “${name}”.`);
				setSelected((prev) => prev.filter((n) => n !== name));
			}
			window.electronAPI.refreshRouting();
			onNext();
		} catch (err) {
			console.error("[Onboarding] failed to add printer(s):", err);
			setError(err.message || "Failed to add printers.");
			await loadRegistered().catch(() => {});
		} finally {
			setSaving(false);
		}
	};

	const summary = [
		selected.length > 0 && `${selected.length} selected`,
		registered.length > 0 && `${registered.length} already added`,
	]
		.filter(Boolean)
		.join(" · ");

	return (
		<StepLayout
			{...layout}
			onNext={handleNext}
			busy={saving}
			busyLabel="Adding printers…"
			nextDisabled={loading || !canContinue}
			nextLabel={selected.length ? `Add ${selected.length} printer${selected.length === 1 ? "" : "s"} & continue` : "Continue"}
			hint={!loading && !canContinue ? "Select at least one printer to continue" : null}
		>
			{error && <div className="form-error onb-error">{error}</div>}

			<div className="onb-toolbar">
				<span className="onb-toolbar__summary">{summary || "No printers selected yet"}</span>
				<button type="button" className="onb-link-btn" onClick={handleRescan} disabled={loading || scanning || saving}>
					<span className={scanning ? "onb-spin" : undefined}><RefreshIcon /></span>
					{scanning ? "Scanning…" : "Rescan printers"}
				</button>
			</div>

			{loading ? (
				<div className="onb-loading">
					<div className="spinner spinner--dark" />
					<p>Looking for printers on this computer…</p>
				</div>
			) : rows.length === 0 ? (
				<div className="onb-empty">
					<span className="onb-empty__icon"><PrinterIcon /></span>
					<p className="onb-empty__title">No printers found</p>
					<p className="onb-empty__text">
						Install your printer in Windows (Settings → Bluetooth &amp; devices → Printers &amp; scanners), then click Rescan printers.
					</p>
				</div>
			) : (
				<div className="onb-grid">
					{rows.map((row, i) => {
						const checked = row.added || selected.includes(row.name);
						const meta = row.elsewhere
							? "Added from another computer"
							: row.offline
								? "Offline"
								: row.isDefault
									? "Ready · System default"
									: "Ready";
						return (
							<button
								type="button"
								key={row.name}
								className={`onb-card onb-printer ${checked ? "onb-card--on" : ""} ${row.added ? "onb-card--locked" : ""}`}
								style={{ animationDelay: `${i * 55}ms` }}
								onClick={() => !row.added && !saving && toggle(row.name)}
								aria-pressed={checked}
								aria-disabled={row.added || saving}
							>
								<span className="onb-card__icon"><PrinterIcon /></span>
								<span className="onb-card__info">
									<span className="onb-card__name">{row.displayName || row.name}</span>
									<span className="onb-card__meta">
										{!row.elsewhere && (
											<span className={`printer-dot ${row.offline ? "printer-dot--off" : "printer-dot--on"}`} />
										)}
										{meta}
									</span>
								</span>
								{row.added ? (
									<span className="onb-badge">Added</span>
								) : (
									<span className="onb-card__check">{checked && <CheckIcon />}</span>
								)}
							</button>
						);
					})}
				</div>
			)}
		</StepLayout>
	);
}

export default PrintersStep;
