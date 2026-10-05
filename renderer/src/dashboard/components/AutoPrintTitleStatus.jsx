import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useAutoPrint } from "../AutoPrintContext";
import { PauseIcon, PlayIcon } from "../icons";

// While automated printing is on, a reminder of it — with the queue's
// pause/resume control — sits in the centre of the app's title bar, where it's
// visible from every tab without taking room in the jobs list.
function AutoPrintTitleStatus() {
	const { autoPrintEnabled, paused, setPaused, queueCount, online } = useAutoPrint();
	// Offline, automated printing holds (manual printing doesn't) — say so.
	const held = paused || !online;
	// The slot is in TitleBar, outside this tree; look it up once mounted.
	const [slot, setSlot] = useState(null);

	useEffect(() => {
		setSlot(document.getElementById("title-bar-slot"));
	}, []);

	if (!slot || !autoPrintEnabled) return null;

	return createPortal(
		<div className={`title-status ${held ? "title-status--paused" : ""}`} role="status">
			<span className={`title-status__dot ${held ? "" : "title-status__dot--live"}`} />
			<span className="title-status__text">
				{paused
					? "Automated printing paused"
					: !online
					? "Auto-print waiting for connection"
					: queueCount > 0
						? `Auto-printing · ${queueCount} in queue`
						: "Auto-print on · idle"}
			</span>
			<button type="button" className="title-status__btn" onClick={() => setPaused((p) => !p)}>
				{paused ? <PlayIcon /> : <PauseIcon />}
				{paused ? "Resume" : "Pause"}
			</button>
		</div>,
		slot
	);
}

export default AutoPrintTitleStatus;
