import { useState, useRef, useEffect } from "react";
import PrinterSelect from "./PrinterSelect";
import { ChevronDownIcon, SvcPaperGlyph, SvcBwGlyph, SvcColorGlyph, SvcSingleGlyph, SvcDoubleGlyph } from "../icons";

export const PAGE_TYPES = ["A4", "A3"];

export function serviceLabel(keys = {}) {
	return `${keys.pageType || "—"}, ${keys.color ? "Color" : "Black & White"}, ${keys.sidedness ? "Double Sided" : "Single Sided"}`;
}

// Short code for a service's configuration, e.g. "A4-BW-DS".
export function serviceCode(keys = {}) {
	return `${keys.pageType || "—"}-${keys.color ? "CL" : "BW"}-${keys.sidedness ? "DS" : "SS"}`;
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

// Compact single-choice dropdown for one part of the service code. The trigger
// shows the option's icon and code; the menu adds the full name.
function CodeSelect({ value, onChange, options, label }) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef(null);
	const current = options.find((o) => o.value === value) || options[0];

	useEffect(() => {
		if (!open) return;
		const onDown = (e) => !rootRef.current?.contains(e.target) && setOpen(false);
		const onKey = (e) => e.key === "Escape" && setOpen(false);
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	return (
		<div className="code-select" ref={rootRef}>
			<button
				type="button"
				className="form-input code-select__trigger"
				onClick={() => setOpen((o) => !o)}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={`${label}: ${current.name}`}
				title={current.name}
			>
				<span className="code-select__icon">{current.Icon && <current.Icon />}</span>
				<span className="code-select__code">{current.code}</span>
				<ChevronDownIcon />
			</button>
			{open && (
				<div className="code-select__menu" role="listbox" aria-label={label}>
					{options.map((o) => (
						<button
							type="button"
							key={String(o.value)}
							role="option"
							aria-selected={o.value === value}
							className={`code-select__item ${o.value === value ? "code-select__item--on" : ""}`}
							onClick={() => {
								onChange(o.value);
								setOpen(false);
							}}
						>
							<span className="code-select__icon">{o.Icon && <o.Icon />}</span>
							<span className="code-select__code">{o.code}</span>
							<span className="code-select__name">{o.name}</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}

const COLOR_OPTIONS = [
	{ value: false, code: "BW", name: "Black & White", Icon: SvcBwGlyph },
	{ value: true, code: "CL", name: "Color", Icon: SvcColorGlyph },
];

const SIDE_OPTIONS = [
	{ value: false, code: "SS", name: "Single Sided", Icon: SvcSingleGlyph },
	{ value: true, code: "DS", name: "Double Sided", Icon: SvcDoubleGlyph },
];

const PAPER_OPTIONS = PAGE_TYPES.map((pt) => ({ value: pt, code: pt, name: `${pt} paper`, Icon: SvcPaperGlyph }));

// Create / edit form for a single service, shown inside a modal. Remount it
// (keyed) per selection so the fields reset cleanly.
// `offline`: the backend can't be reached, so the form can't be saved (the
// operator's input stays put until it can).
function ServiceForm({ service, printers, error, saving, offline = false, onSave, onCancel }) {
	const isNew = !service._id;
	const [rate, setRate] = useState(service.rate ?? "");
	const [color, setColor] = useState(service.keys?.color ?? false);
	const [pageType, setPageType] = useState(service.keys?.pageType || "A4");
	const [sidedness, setSidedness] = useState(service.keys?.sidedness ?? false);

	// One entry per selected printer, each with its own auto-print toggle. Saved
	// printers keep their setting; newly picked ones start with auto on.
	const [printerSel, setPrinterSel] = useState(() =>
		(service.printers || [])
			.map((entry) => ({ printer: printerIdOf(entry), useAuto: !!entry.useAuto }))
			.filter((entry) => entry.printer)
	);

	const selectedIds = printerSel.map((p) => p.printer);

	// Keep the per-printer rows in sync with the dropdown, preserving the auto
	// toggle for printers that stay selected.
	const handlePrintersChange = (ids) =>
		setPrinterSel(
			ids.map((id) => printerSel.find((p) => p.printer === id) || { printer: id, useAuto: true })
		);

	const setUseAutoFor = (id, useAuto) =>
		setPrinterSel((prev) => prev.map((p) => (p.printer === id ? { ...p, useAuto } : p)));

	const name = serviceCode({ pageType, color, sidedness });
	const rateNum = Number(rate);
	// Only checks a number was entered; the backend owns the allowed range.
	const isRateInvalid = rate === "" || isNaN(rateNum);
	const noPrinters = printers.length === 0;
	const isSubmitDisabled = saving || offline || isRateInvalid || printerSel.length === 0;

	const submit = (e) => {
		e.preventDefault();
		onSave({
			rate: rateNum || 0,
			keys: { pageType, color, sidedness },
			printers: printerSel.map((p) => ({ useAuto: p.useAuto, printer: p.printer })),
		});
	};

	return (
		<form className="service-form" onSubmit={submit}>
			<h3 className="modal-title">{isNew ? "Add new Service" : `Edit ${name}`}</h3>

			{error && <div className="form-error">{error}</div>}

			{/* A service's definition is fixed once created; editing only changes
			    its printers and rate. */}
			{isNew && (
				<div className="form-field">
					<label className="form-label">Service</label>
					<div className="service-form__defs">
						<CodeSelect label="Paper size" value={pageType} onChange={setPageType} options={PAPER_OPTIONS} />
						<span className="service-form__dash">-</span>
						<CodeSelect label="Color" value={color} onChange={setColor} options={COLOR_OPTIONS} />
						<span className="service-form__dash">-</span>
						<CodeSelect label="Sides" value={sidedness} onChange={setSidedness} options={SIDE_OPTIONS} />
					</div>
				</div>
			)}

			<div className="form-field">
				<label className="form-label">Printers</label>
				<p className="form-sublabel">
					{noPrinters
						? "Add a printer in Settings → Printers before creating a service."
						: "Select one or more printers to be assigned to this service."}
				</p>
				<PrinterSelect
					printers={printers}
					value={selectedIds}
					onChange={handlePrintersChange}
					disabled={saving || noPrinters}
				/>
				{printerSel.length > 0 && (
					<div className="auto-list">
						{printerSel.map((sel) => {
							const printer = printers.find((p) => p._id === sel.printer);
							return (
								<div className="auto-row" key={sel.printer}>
									<span className="auto-row__printer">
										<span className={`printer-dot ${printer?.online ? "printer-dot--on" : "printer-dot--off"}`} />
										{printer?.label || "Unknown printer"}
									</span>
									<span className="auto-row__toggle">
										<span className="auto-row__toggle-label">Auto</span>
										<button
											type="button"
											className={`toggle ${sel.useAuto ? "toggle--on" : ""}`}
											role="switch"
											aria-checked={sel.useAuto}
											aria-label={`Auto-print on ${printer?.label || "this printer"}`}
											title="Print this service's jobs on this printer automatically"
											onClick={() => setUseAutoFor(sel.printer, !sel.useAuto)}
											disabled={saving}
										>
											<span className="toggle__knob" />
										</button>
									</span>
								</div>
							);
						})}
					</div>
				)}
			</div>

			<div className="service-form__row">
				<div className="form-field">
					<label className="form-label">Service</label>
					<input className="form-input" type="text" value={name} disabled readOnly tabIndex={-1} />
				</div>
				<div className="form-field">
					<label className="form-label">Rate (Rs. per page)</label>
					<input
						className="form-input"
						type="number"
						step="any"
						value={rate}
						onChange={(e) => setRate(e.target.value)}
						required
					/>
				</div>
			</div>

			<div className="action-panel">
				<button type="button" className="btn-outline" onClick={onCancel} disabled={saving}>
					Cancel
				</button>
				<button
					type="submit"
					className="btn-gradient"
					disabled={isSubmitDisabled}
					title={offline ? "You're offline — saving needs a connection" : undefined}
				>
					{saving ? "Saving…" : isNew ? "Add Service" : "Save Changes"}
				</button>
			</div>
		</form>
	);
}

export default ServiceForm;
