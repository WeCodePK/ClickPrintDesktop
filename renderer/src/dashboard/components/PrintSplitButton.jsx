import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { ChevronDownIcon } from "../icons";

// The main button prints without an explicit device — each document is routed
// to its service's automated printer (resolved in AutoPrintContext). The
// dropdown overrides that with a specific printer for this one print.
function PrintSplitButton({
	onPrint,
	onOpen,
	printers = [],
	disabled = false,
	busy = false,
	label,
	busyLabel = "Printing…",
	size = "md",
	showInfo = false,
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

	return (
		<div className={`print-split print-split--${size}`}>
			<div className="print-split__row" ref={rowRef}>
				<button
					type="button"
					className="print-split__main"
					onClick={() => onPrint(undefined)}
					disabled={disabled || busy}
				>
					{busy ? (
						<>
							<div className="spinner spinner--dark" style={{ borderTopColor: "#111b21", width: "14px", height: "14px" }} />
							{busyLabel}
						</>
					) : (
						label
					)}
				</button>
				<button
					type="button"
					className="print-split__toggle"
					onClick={() => (open ? setOpen(false) : openMenu())}
					disabled={disabled || busy || printers.length === 0}
					aria-label="Print to a different printer"
					title="Print to a different printer"
				>
					<ChevronDownIcon />
				</button>
			</div>

			{showInfo && (
				<span className="print-split__info" title="Each document prints to the automated printer of its matching service">
					Routed by service
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
