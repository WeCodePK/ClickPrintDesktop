import { useState } from "react";
import { Segmented } from "./Segmented";
import PrinterSelect from "./PrinterSelect";
import { CheckIcon } from "../icons";

const PAGE_TYPES = ["A4", "A3"];
const RATE_MIN = 1;
const RATE_MAX = 200;

export function serviceLabel(keys = {}) {
	return `${keys.pageType || "—"}, ${keys.color ? "Color" : "Black & White"}, ${keys.sidedness ? "Double Sided" : "Single Sided"}`;
}

// Two services clash when they price the same print configuration.
export function sameKeys(a = {}, b = {}) {
	return (
		a.pageType === b.pageType &&
		!!a.color === !!b.color &&
		!!a.sidedness === !!b.sidedness
	);
}

// A service's printer id, whether the backend returns it raw or populated.
export function printerIdOf(entry) {
	if (!entry) return "";
	return typeof entry.printer === "string" ? entry.printer : entry.printer?._id || "";
}

// The shop's registered printers shaped for ServiceForm's `printers` prop, each
// tagged with whether it's reachable right now.
export async function loadServicePrinters() {
	const [registered, local] = await Promise.all([
		window.electronAPI.fetchPrinters(),
		window.electronAPI.listPrinters(),
	]);
	if (!registered?.success) return null;
	const localByName = new Map((local?.success ? local.data || [] : []).map((p) => [p.name, p]));
	return (registered.data || []).map((p) => ({
		_id: p._id,
		name: p.name,
		label: localByName.get(p.name)?.displayName || p.name,
		online: localByName.has(p.name),
	}));
}

// Create / edit form for a single service, shown inside a modal. Remount it
// (keyed) per selection so the fields reset cleanly.
function ServiceForm({ service, printers, error, saving, onSave, onCancel }) {
	const isNew = !service._id;
	const [rate, setRate] = useState(service.rate ?? "");
	const [color, setColor] = useState(service.keys?.color ?? false);
	const [pageType, setPageType] = useState(service.keys?.pageType || "A4");
	const [sidedness, setSidedness] = useState(service.keys?.sidedness ?? false);

	// One entry per selected printer. `useAuto` starts null so the operator has to
	// make an explicit Yes/No choice for each.
	const [printerSel, setPrinterSel] = useState(() =>
		(service.printers || [])
			.map((entry) => ({ printer: printerIdOf(entry), useAuto: entry.useAuto ?? null }))
			.filter((entry) => entry.printer)
	);

	const selectedIds = printerSel.map((p) => p.printer);

	// Keep the per-printer rows in sync with the dropdown, preserving any Yes/No
	// already chosen for printers that stay selected.
	const handlePrintersChange = (ids) =>
		setPrinterSel(
			ids.map((id) => printerSel.find((p) => p.printer === id) || { printer: id, useAuto: null })
		);

	const setUseAutoFor = (id, useAuto) =>
		setPrinterSel((prev) => prev.map((p) => (p.printer === id ? { ...p, useAuto } : p)));

	const name = serviceLabel({ pageType, color, sidedness });
	const rateNum = Number(rate);
	const isRateInvalid = rate === "" || isNaN(rateNum) || rateNum < RATE_MIN || rateNum > RATE_MAX;
	const noPrinters = printers.length === 0;
	const autoUnanswered = printerSel.some((p) => p.useAuto === null);
	const isSubmitDisabled = saving || isRateInvalid || printerSel.length === 0 || autoUnanswered;

	const submit = (e) => {
		e.preventDefault();
		onSave({
			rate: rateNum || 0,
			keys: { pageType, color, sidedness },
			printers: printerSel.map((p) => ({ useAuto: !!p.useAuto, printer: p.printer })),
		});
	};

	return (
		<form className="service-form" onSubmit={submit}>
			<h3 className="modal-title">{isNew ? "New Service" : "Edit Service"}</h3>

			{error && <div className="form-error">{error}</div>}

			<div className="form-field">
				<label className="form-label" style={{ marginBottom: "2.5rem", textAlign: "center" }}>{name}</label>
			</div>

			<div className="form-field">
				<label className="form-label">Rate (Rs. per page)</label>
				<input
					className="form-input"
					type="number"
					min={RATE_MIN}
					max={RATE_MAX}
					step="1"
					value={rate}
					onChange={(e) => setRate(e.target.value)}
					required
				/>
				{isRateInvalid && (
					<span className="form-hint">Enter a rate between Rs. {RATE_MIN} and Rs. {RATE_MAX} per page.</span>
				)}
			</div>

			<div className="form-field">
				<label className="form-label">Paper Size</label>
				<select className="form-input" value={pageType} onChange={(e) => setPageType(e.target.value)}>
					{PAGE_TYPES.map((pt) => (
						<option key={pt} value={pt}>{pt}</option>
					))}
				</select>
			</div>

			<div className="form-field">
				<label className="form-label">Color</label>
				<Segmented
					value={color}
					onChange={setColor}
					options={[
						{ label: "Black & White", value: false, activeClass: "segmented__btn--active" },
						{ label: "Color", value: true, activeClass: "segmented__btn--colorful" },
					]}
				/>
			</div>

			<div className="form-field">
				<label className="form-label">Sidedness</label>
				<Segmented
					value={sidedness}
					onChange={setSidedness}
					options={[
						{ label: "Single", value: false },
						{ label: "Double", value: true },
					]}
				/>
			</div>

			<div className="form-field">
				<label className="form-label">Printers</label>
				<PrinterSelect
					printers={printers}
					value={selectedIds}
					onChange={handlePrintersChange}
					disabled={saving || noPrinters}
				/>
				{(noPrinters || printerSel.length === 0) && (
					<span className="form-hint">
						{noPrinters
							? "Add a printer in Settings → Printers before creating a service."
							: "Select one or more printers to be assigned to this service."}
					</span>
				)}
			</div>

			{printerSel.length > 0 && (
				<div className="form-field">
					<label className="form-label">Automated printing</label>
					<div className="auto-list">
						{printerSel.map((sel) => {
							const printer = printers.find((p) => p._id === sel.printer);
							return (
								<div className="auto-row" key={sel.printer}>
									<span className="auto-row__printer">
										<span className={`printer-dot ${printer?.online ? "printer-dot--on" : "printer-dot--off"}`} />
										{printer?.label || "Unknown printer"}
									</span>
									<span className="auto-row__choices">
										{[
											{ label: "Yes", choice: true },
											{ label: "No", choice: false },
										].map(({ label, choice }) => {
											const on = sel.useAuto === choice;
											return (
												<button
													type="button"
													key={label}
													className={`form-check ${on ? "form-check--on" : ""}`}
													onClick={() => setUseAutoFor(sel.printer, choice)}
													role="checkbox"
													aria-checked={on}
													disabled={saving}
												>
													<span className="form-check__box">{on && <CheckIcon />}</span>
													<span className="form-check__label">{label}</span>
												</button>
											);
										})}
									</span>
								</div>
							);
						})}
					</div>
					{autoUnanswered && (
						<span className="form-hint">
							Choose whether each printer can be used for automated printing on this service.
						</span>
					)}
				</div>
			)}

			<div className="action-panel">
				<button type="button" className="btn-outline" onClick={onCancel} disabled={saving}>
					Cancel
				</button>
				<button type="submit" className="btn-gradient" disabled={isSubmitDisabled}>
					{saving ? "Saving…" : isNew ? "Create Service" : "Save Changes"}
				</button>
			</div>
		</form>
	);
}

export default ServiceForm;
