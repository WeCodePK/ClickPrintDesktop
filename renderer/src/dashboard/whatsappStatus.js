import { useState, useEffect } from "react";

// Human-readable description of each WhatsApp link state (see main/whatsapp.js).
export const WA_STATUS = {
	idle:         { label: "Not connected",    tone: "off",  busy: false },
	logged_out:   { label: "Unlinked",         tone: "off",  busy: false },
	connecting:   { label: "Connecting…",      tone: "warn", busy: true },
	reconnecting: { label: "Reconnecting…",    tone: "warn", busy: true },
	qr:           { label: "Waiting for scan", tone: "warn", busy: false },
	open:         { label: "Connected",        tone: "ok",   busy: false },
};

const EMPTY = { state: "idle", qr: null, me: null, error: null, enabled: true, flow: "menu" };

// Live WhatsApp link snapshot { state, qr, me, error, enabled, flow } from the
// main process; `enabled` is false while message handling is paused, and `flow`
// is the ordering flow ("menu" | "chat") for new orders.
// Seeded on mount (replay for a late mount) and kept live via the push channel.
export function useWhatsAppStatus() {
	const [status, setStatus] = useState(EMPTY);

	useEffect(() => {
		let active = true;
		window.electronAPI?.getWhatsAppStatus?.()
			.then((s) => { if (active && s) setStatus(s); })
			.catch(() => {});
		const unsubscribe = window.electronAPI?.onWhatsAppStatus?.((s) => setStatus(s));
		return () => {
			active = false;
			if (unsubscribe) unsubscribe();
		};
	}, []);

	return { status, meta: WA_STATUS[status.state] || WA_STATUS.idle };
}

// "923001234567:12@s.whatsapp.net" → "+923001234567"; LIDs are shown as-is.
export function formatWhatsAppId(jid) {
	if (!jid) return "";
	const [user, domain] = String(jid).split("@");
	const bare = user.split(":")[0];
	if (domain === "lid") return `${bare}@lid`;
	return /^\d+$/.test(bare) ? `+${bare}` : bare;
}
