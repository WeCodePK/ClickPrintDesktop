import { useEffect, useState } from "react";

// Whether the backend can be reached, as main sees it (main/connectivity.js):
// { online, since, lastOnlineAt, authExpired, pendingSync }. Optimistic until
// main answers, so nothing flashes "offline" on mount.
const INITIAL = { online: true, since: null, lastOnlineAt: null, authExpired: false, pendingSync: 0 };

export function useNetStatus() {
	const [status, setStatus] = useState(INITIAL);

	useEffect(() => {
		let active = true;
		window.electronAPI?.getNetStatus?.()
			.then((s) => active && s && setStatus(s))
			.catch(() => {});
		const unsubscribe = window.electronAPI?.onNetStatus?.((s) => s && setStatus(s));
		return () => {
			active = false;
			unsubscribe?.();
		};
	}, []);

	return status;
}

// "10:42 AM", or "3 Oct, 10:42 AM" when it wasn't today.
export function formatSavedAt(value) {
	if (!value) return null;
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return null;
	const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	if (date.toDateString() === new Date().toDateString()) return time;
	return `${date.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
}

// The standard explanation on a control that needs the backend.
export const OFFLINE_ACTION_HINT = "You're offline — this needs a connection";
