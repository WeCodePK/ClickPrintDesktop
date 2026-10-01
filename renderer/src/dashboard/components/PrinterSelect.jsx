import { useState, useRef, useEffect } from "react";
import { ChevronDownIcon, CheckIcon } from "../icons";

// Multi-select dropdown for the shop's registered printers, with a status dot
// per entry (green = online, grey = offline). `value` is an array of printer ids.
// The menu stays open while picking and renders in flow under the trigger, so
// it pushes the per-printer rows below it down instead of covering them.
function PrinterSelect({ printers, value = [], onChange, disabled }) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef(null);

	const selected = printers.filter((p) => value.includes(p._id));

	const toggle = (id) =>
		onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);

	useEffect(() => {
		if (!open) return;
		const onDown = (e) => {
			if (rootRef.current?.contains(e.target)) return;
			setOpen(false);
		};
		const onKey = (e) => e.key === "Escape" && setOpen(false);
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	return (
		<div className="printer-select" ref={rootRef}>
			<button
				type="button"
				className="form-input printer-select__trigger"
				onClick={() => setOpen((o) => !o)}
				disabled={disabled}
				aria-expanded={open}
			>
				{selected.length === 0 ? (
					<span className="printer-select__placeholder">Select printers</span>
				) : (
					<span className="printer-select__value">
						{selected.length} {selected.length === 1 ? "printer" : "printers"} selected
					</span>
				)}
				<ChevronDownIcon />
			</button>

			{open && (
				<div className="printer-select__menu">
					{printers.map((p) => {
						const checked = value.includes(p._id);
						return (
							<button
								type="button"
								key={p._id}
								className={`printer-select__item ${checked ? "printer-select__item--on" : ""}`}
								onClick={() => toggle(p._id)}
							>
								<span className="printer-select__check">{checked && <CheckIcon />}</span>
								<span className={`printer-dot ${p.online ? "printer-dot--on" : "printer-dot--off"}`} />
								<span className="printer-select__item-name">{p.label}</span>
								<span className="printer-select__item-status">{p.online ? "Online" : "Offline"}</span>
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}

export default PrinterSelect;
