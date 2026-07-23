import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { BoltIcon } from "../icons";
import ConfirmDialog from "./ConfirmDialog";
import { useAutoPrint } from "../AutoPrintContext";

/**
 * Sidebar item (next to the connection indicator) for automated printing — a
 * bolt icon with an on/off status pip. Clicking it opens a popover with a single
 * persisted toggle. Guards: can only be turned ON when at least one service has
 * a printer marked for automated printing (documents route by service — there is
 * no app-wide default printer), and turning it OFF while a queue is draining
 * asks for confirmation.
 */
function AutoPrintSwitcher() {
	const { autoPrintEnabled, enableAutoPrint, disableAutoPrint, queueCount, autoRouteReady, printersReady, refreshPrinterState } = useAutoPrint();
	const [open, setOpen] = useState(false);
	const [confirmOff, setConfirmOff] = useState(false);
	const wrapRef = useRef(null);

	// Refresh the validated printer state whenever the popover opens.
	useEffect(() => {
		if (open) refreshPrinterState();
	}, [open, refreshPrinterState]);

	// Close the popover on an outside click or Escape.
	useEffect(() => {
		if (!open) return;
		const onDown = (e) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
		};
		const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	const loaded = printersReady;
	const canEnable = autoRouteReady;

	const handleToggle = () => {
		if (autoPrintEnabled) {
			// Turning OFF — warn if a queue is still draining (edge case 1).
			if (queueCount > 0) setConfirmOff(true);
			else disableAutoPrint();
		} else {
			if (!canEnable) return; // guarded (edge case 3)
			enableAutoPrint();
		}
	};

	return (
		<div className="conn-switcher" ref={wrapRef}>
			<button
				className={`db-tab conn-btn ${open ? "db-tab--active" : ""}`}
				onClick={() => setOpen((v) => !v)}
				title={`Automated printing: ${autoPrintEnabled ? "on" : "off"}`}
				id="autoprint-switcher-btn"
			>
				<span className="db-tab__icon">
					<BoltIcon />
				</span>
				<span className={`conn-btn__dot conn-btn__dot--${autoPrintEnabled ? "ok" : "off"}`} />
			</button>

			{open && (
				<div className="conn-popover">
					<div className="autoprint-popover__row">
						<div className="autoprint-popover__text">
							<div className="conn-popover__status-label">Automated Printing</div>
							<div className="autoprint-popover__hint">
								{autoPrintEnabled
									? queueCount > 0
										? `On · ${queueCount} job${queueCount === 1 ? "" : "s"} in queue`
										: "On · waiting for jobs"
									: "Off · jobs are printed manually"}
							</div>
						</div>
						<button
							type="button"
							className={`toggle ${autoPrintEnabled ? "toggle--on" : ""}`}
							onClick={handleToggle}
							disabled={!loaded || (!autoPrintEnabled && !canEnable)}
							role="switch"
							aria-checked={autoPrintEnabled}
						>
							<span className="toggle__knob" />
						</button>
					</div>

					{loaded && !autoPrintEnabled && !canEnable && (
						<div className="conn-popover__hint">
							No printer is set up for automated printing. In the Services tab, mark a
							printer “Use for automated printing” on a service first.
						</div>
					)}
				</div>
			)}

			{confirmOff && createPortal(
				<ConfirmDialog
					title="Turn off automated printing?"
					message={`There ${queueCount === 1 ? "is" : "are"} still ${queueCount} job${queueCount === 1 ? "" : "s"} in the queue. ${queueCount === 1 ? "It" : "They"} will finish printing, but no new jobs will be added to the queue. Turn it off?`}
					confirmLabel="Turn off"
					cancelLabel="Keep on"
					onConfirm={() => {
						setConfirmOff(false);
						disableAutoPrint();
					}}
					onCancel={() => setConfirmOff(false)}
				/>,
				document.body
			)}
		</div>
	);
}

export default AutoPrintSwitcher;
