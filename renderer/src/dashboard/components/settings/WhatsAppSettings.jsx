import { useState } from "react";
import { WhatsAppIcon, TrashIcon } from "../../icons";
import { useWhatsAppStatus, formatWhatsAppId } from "../../whatsappStatus";
import ConfirmDialog from "../ConfirmDialog";
import { Segmented } from "../Segmented";

// The WhatsApp ordering flows a shop can pick between (see main/whatsapp.js's
// FLOWS). Removing a flow later: drop its entry here too.
const FLOW_OPTIONS = [
	{
		value: "menu",
		label: "Numbered menu",
		caption: "Customers change each file's settings by replying with numbers from a menu, then confirm twice.",
	},
	{
		value: "chat",
		label: "AI chat",
		caption: "Customers say how to print in their own words, in English or Urdu, and confirm once after seeing the total.",
	},
];

// Turns what the operator typed into a contact id, or an error message.
// Accepts a phone number in any common format ("+92 300-1234567") or a full
// WhatsApp id ("…@lid", "…@s.whatsapp.net"). Numbers are stored as "+digits".
function parseContact(input) {
	const value = input.trim();
	if (!value) return { error: "Enter a phone number or WhatsApp ID." };
	if (value.includes("@")) {
		const match = value.toLowerCase().match(/^(\d+)(?::\d+)?@(lid|s\.whatsapp\.net)$/);
		if (!match) return { error: "WhatsApp IDs look like 1234567890@lid or 923001234567@s.whatsapp.net." };
		return { id: match[2] === "lid" ? `${match[1]}@lid` : `+${match[1]}` };
	}
	if (!/^[+\d\s()-]+$/.test(value)) return { error: "Phone numbers can only contain digits, spaces, +, - and brackets." };
	const digits = value.replace(/\D/g, "");
	if (digits.length < 7 || digits.length > 15) return { error: "Enter the full number with country code, e.g. +92 300 1234567." };
	return { id: `+${digits}` };
}

// Contacts whose incoming WhatsApp messages are not forwarded to ClickPrint.
// UI-only for now: the list lives in component state. When the backend is
// ready, load it in an effect and swap add/remove for the API calls — the rest
// of the section already works on { id, name } entries.
function useExcludedContacts() {
	const [contacts, setContacts] = useState([]);

	const add = (contact) => setContacts((list) => [contact, ...list]);
	const remove = (id) => setContacts((list) => list.filter((c) => c.id !== id));

	return { contacts, add, remove };
}

function ConnectionCard() {
	const { status, meta } = useWhatsAppStatus();
	const [busy, setBusy] = useState(false);
	const [confirmUnlink, setConfirmUnlink] = useState(false);

	const connect = async () => {
		setBusy(true);
		try {
			await window.electronAPI.connectWhatsApp();
		} finally {
			setBusy(false);
		}
	};

	const unlink = async () => {
		setConfirmUnlink(false);
		setBusy(true);
		try {
			await window.electronAPI.unlinkWhatsApp();
		} finally {
			setBusy(false);
		}
	};

	const unlinked = status.state === "idle" || status.state === "logged_out";

	return (
		<section className="wa-card">
			<div className="wa-card__head">
				<div>
					<h4 className="wa-card__title">Connection</h4>
				</div>
				<div className="wa-status">
					{meta.busy ? (
						<span className="conn-popover__spinner" />
					) : (
						<span className={`conn-popover__dot conn-popover__dot--${meta.tone}`} />
					)}
					<span className="wa-status__label">{meta.label}</span>
				</div>
			</div>

			{status.error && <div className="form-error" style={{ marginBottom: 0 }}>{status.error}</div>}

			{unlinked && (
				<button className="btn-gradient wa-card__action" onClick={connect} disabled={busy}>
					Connect WhatsApp
				</button>
			)}

			{meta.busy && (
				<div className="wa-card__waiting">
					<div className="spinner spinner--dark" />
				</div>
			)}

			{status.state === "qr" && status.qr && (
				<div className="wa-pair">
					<div className="wa-pair__qr">
						<img src={status.qr} alt="WhatsApp QR code" />
					</div>
					<ol className="wa-pair__steps">
						<li>Open WhatsApp on your phone</li>
						<li>Tap <strong>Settings</strong> → <strong>Linked devices</strong></li>
						<li>Tap <strong>Link a device</strong> and scan this code</li>
						<li className="wa-pair__note">The code refreshes on its own while this page is open.</li>
					</ol>
				</div>
			)}

			{status.state === "open" && (
				<div className="wa-account">
					<span className="conn-shop__avatar">
						{(status.me?.name || "W").trim().charAt(0).toUpperCase()}
					</span>
					<div className="wa-account__info">
						<span className="wa-account__name">{status.me?.name || "WhatsApp"}</span>
						<span className="wa-account__number">{formatWhatsAppId(status.me?.id)}</span>
					</div>
					<button className="btn-outline btn-outline-danger wa-account__unlink" onClick={() => setConfirmUnlink(true)} disabled={busy}>
						Unlink
					</button>
				</div>
			)}

			{confirmUnlink && (
				<ConfirmDialog
					title="Unlink WhatsApp?"
					message="ClickPrint will stop receiving and sending WhatsApp messages. You'll need to scan a new QR code to link it again."
					confirmLabel="Unlink"
					danger
					onConfirm={unlink}
					onCancel={() => setConfirmUnlink(false)}
				/>
			)}
		</section>
	);
}

// How customers place orders over WhatsApp: the numbered menu or the AI chat.
function ConversationStyleCard() {
	const { status } = useWhatsAppStatus();
	const [saving, setSaving] = useState(false);
	const flow = FLOW_OPTIONS.some((o) => o.value === status.flow) ? status.flow : "menu";
	const selected = FLOW_OPTIONS.find((o) => o.value === flow);

	const choose = async (value) => {
		if (value === flow || saving) return;
		setSaving(true);
		try {
			await window.electronAPI.setWhatsAppFlow(value);
		} finally {
			setSaving(false);
		}
	};

	return (
		<section className="wa-card">
			<div className="wa-card__head">
				<div>
					<h4 className="wa-card__title">Conversation style</h4>
					<p className="wa-card__sub">
						How customers tell you their print settings. Orders already in progress keep their style.
					</p>
				</div>
			</div>
			<Segmented options={FLOW_OPTIONS} value={flow} onChange={choose} />
			<p className="wa-card__sub">{selected.caption}</p>
		</section>
	);
}

function ExcludedContactsCard() {
	const { contacts, add, remove } = useExcludedContacts();
	const [number, setNumber] = useState("");
	const [name, setName] = useState("");
	const [error, setError] = useState(null);

	const handleAdd = (e) => {
		e.preventDefault();
		const parsed = parseContact(number);
		if (parsed.error) {
			setError(parsed.error);
			return;
		}
		if (contacts.some((c) => c.id === parsed.id)) {
			setError("That contact is already excluded.");
			return;
		}
		add({ id: parsed.id, name: name.trim() || null });
		setNumber("");
		setName("");
		setError(null);
	};

	return (
		<section className="wa-card">
			<div className="wa-card__head">
				<div>
					<h4 className="wa-card__title">Excluded contacts</h4>
					<p className="wa-card__sub">
						Messages from these contacts stay in WhatsApp and are ignored by ClickPrint.
					</p>
				</div>
				{contacts.length > 0 && <span className="wa-count">{contacts.length}</span>}
			</div>

			<form className="wa-exclude-form" onSubmit={handleAdd}>
				<input
					className="form-input"
					placeholder="Name (optional)"
					value={name}
					maxLength={50}
					onChange={(e) => setName(e.target.value)}
				/>
				<input
					className="form-input"
					placeholder="Phone number or WhatsApp ID"
					value={number}
					onChange={(e) => { setNumber(e.target.value); setError(null); }}
				/>
				<button type="submit" className="btn-gradient">Add</button>
			</form>
			{error && <span className="wa-exclude-form__error">{error}</span>}

			{contacts.length === 0 ? (
				<div className="wa-empty">No excluded contacts.</div>
			) : (
				<ul className="wa-contacts">
					{contacts.map((c) => (
						<li key={c.id} className="wa-contact">
							<span className="conn-shop__avatar">
								{(c.name || "#").charAt(0).toUpperCase()}
							</span>
							<div className="wa-contact__info">
								<span className="wa-contact__name">{c.name || c.id}</span>
								{c.name && <span className="wa-contact__id">{c.id}</span>}
							</div>
							<button
								type="button"
								className="wa-contact__remove"
								onClick={() => remove(c.id)}
								title="Remove from excluded"
							>
								<TrashIcon />
							</button>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

// Settings → WhatsApp: link the shop's account, pause message handling, and
// manage excluded contacts.
function WhatsAppSettings() {
	const { status } = useWhatsAppStatus();
	const [saving, setSaving] = useState(false);
	const enabled = status.enabled !== false;

	// Pausing keeps the link: messages still arrive in WhatsApp, ClickPrint just
	// ignores them until this is switched back on.
	const toggle = async () => {
		setSaving(true);
		try {
			await window.electronAPI.setWhatsAppEnabled(!enabled);
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="db-detail__view wa-settings">
			<div className="settings-panel__header">
				<div>
					<h3 className="db-detail__title wa-settings__title">
						<WhatsAppIcon />
						WhatsApp
					</h3>
					<p className="settings-panel__sub">
						Link your shop's WhatsApp so that ClickPrint can process print jobs automatically.
					</p>
				</div>
				<div className="wa-handling">
					<button
						type="button"
						className={`toggle ${enabled ? "toggle--on" : ""}`}
						onClick={toggle}
						disabled={saving}
						role="switch"
						aria-checked={enabled}
						aria-label="Handle WhatsApp messages"
						title={enabled ? "Pause WhatsApp message handling" : "Resume WhatsApp message handling"}
					>
						<span className="toggle__knob" />
					</button>
				</div>
			</div>

			<ConnectionCard />
			<ConversationStyleCard />
			<ExcludedContactsCard />
		</div>
	);
}

export default WhatsAppSettings;
