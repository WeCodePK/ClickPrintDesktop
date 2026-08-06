import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { ChevronDownIcon, StopIcon } from "../icons";

// The main button prints without an explicit device — each document is routed
// to its service's automated printer (resolved in AutoPrintContext). The
// dropdown overrides that with a specific printer for this one print.
//
// While a print-all batch is running, `stopMode` turns the whole control into a
// single Stop button (accent orange, no printer dropdown) wired to `onStop`;
// the helper line under the button (`info`) carries the "Printing…" status.
function PrintSplitButton({
	onPrint,
	onOpen,
	printers = [],
	disabled = false,
	label,
	size = "md",
	showInfo = false,
	// Replaces the default "Routed by service" helper line; `infoActive` gives it
	// the live (primary-coloured) treatment while something is printing.
	info = null,
	infoActive = false,
	stopMode = false,
	onStop = null,
	// "default" = the green print action; "retry" = accent orange, used once the
	// document has failed and this button re-attempts it.
	tone = "default",
}) {
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState(null);
	const rowRef = useRef(null);
	const menuRef = useRef(null);

	const openMenu = () => {
		onOpen?.();
		const rect = rowRef.current?.getBoundingClientRect();
		if (rect) setPos({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
		setOpen(true);
	};

	useEffect(() => {
		if (!open) return;
		const onDocDown = (e) => {
			if (menuRef.current?.contains(e.target) || rowRef.current?.contains(e.target)) return;
			setOpen(false);
		};
		const onKey = (e) => e.key === "Escape" && setOpen(false);
		const close = () => setOpen(false);
		document.addEventListener("mousedown", onDocDown);
		document.addEventListener("keydown", onKey);
		window.addEventListener("resize", close);
		window.addEventListener("scroll", close, true);
		return () => {
			document.removeEventListener("mousedown", onDocDown);
			document.removeEventListener("keydown", onKey);
			window.removeEventListener("resize", close);
			window.removeEventListener("scroll", close, true);
		};
	}, [open]);

	const pick = (deviceName) => {
		setOpen(false);
		onPrint(deviceName);
	};

	const orange = stopMode || tone === "retry";
	return (
		<div className={`print-split print-split--${size} ${orange ? "print-split--retry" : ""}`}>
			<div className="print-split__row" ref={rowRef}>
				{stopMode ? (
					// Stop is always clickable — it must work exactly while a batch runs.
					<button
						type="button"
						className="print-split__main print-split__main--solo"
						onClick={() => onStop && onStop()}
						title="Stop after the current document finishes"
					>
						<StopIcon />
						Stop
					</button>
				) : (
					<>
						<button
							type="button"
							className="print-split__main"
							onClick={() => onPrint(undefined)}
							disabled={disabled}
						>
							{label}
						</button>
						<button
							type="button"
							className="print-split__toggle"
							onClick={() => (open ? setOpen(false) : openMenu())}
							disabled={disabled || printers.length === 0}
							aria-label="Print to a different printer"
							title="Print to a different printer"
						>
							<ChevronDownIcon />
						</button>
					</>
				)}
			</div>

			{showInfo && (
				<span
					className={`print-split__info ${infoActive ? "print-split__info--active" : ""}`}
					title={info || "Each document prints to the automated printer of its matching service"}
				>
					{info || "Routed by service"}
				</span>
			)}

			{open && pos && createPortal(
				<div
					ref={menuRef}
					className="print-split__menu"
					style={{ position: "fixed", top: pos.top, right: pos.right }}
				>
					<div className="print-split__menu-title">Print to…</div>
					{printers.map((p) => (
						<button
							key={p.name}
							type="button"
							className="print-split__item"
							onClick={() => pick(p.name)}
						>
							<span className="print-split__item-name">{p.displayName}</span>
						</button>
					))}
				</div>,
				document.body
			)}
		</div>
	);
}

export default PrintSplitButton;
