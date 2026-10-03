// Shop-scoped exclusions persisted in the app's disk store. Phone identities
// and WhatsApp LIDs are distinct; Baileys supplies the mapping between them.
const STORE_KEY = "whatsappExcludedContacts";

function normalizeContactId(input) {
	if (typeof input !== "string") return null;
	const value = input.trim();
	const jid = value.match(/^(\d+)(?::\d+)?@(lid|s\.whatsapp\.net)$/i);
	if (jid?.[2].toLowerCase() === "lid") return `${jid[1]}@lid`;
	if (!jid && !/^[+\d\s()-]+$/.test(value)) return null;
	let digits = jid ? jid[1] : value.replace(/\D/g, "");
	if (digits.startsWith("00")) digits = digits.slice(2);
	if (/^03\d{9}$/.test(digits)) digits = `92${digits.slice(1)}`;
	return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : null;
}

function createExcludedContacts(store) {
	function all() {
		const saved = store.get(STORE_KEY);
		return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
	}

	function list(shopId) {
		const saved = all()[shopId];
		if (!Array.isArray(saved)) return [];
		const seen = new Set();
		return saved.flatMap((contact) => {
			const id = normalizeContactId(contact?.id);
			if (!id || seen.has(id)) return [];
			seen.add(id);
			return [{ id, name: typeof contact.name === "string" ? contact.name.trim().slice(0, 50) || null : null }];
		});
	}

	function save(shopId, contacts) {
		if (!store.set(STORE_KEY, { ...all(), [shopId]: contacts })) {
			return { success: false, message: "Couldn't save excluded contacts to disk. Please try again." };
		}
		return { success: true, data: contacts };
	}

	function add(shopId, contact) {
		const id = normalizeContactId(contact?.id);
		if (!id) return { success: false, message: "Enter a valid phone number or WhatsApp ID." };
		const contacts = list(shopId);
		if (contacts.some((c) => c.id === id)) return { success: false, message: "That contact is already excluded." };
		const name = typeof contact.name === "string" ? contact.name.trim().slice(0, 50) || null : null;
		return save(shopId, [{ id, name }, ...contacts]);
	}

	function remove(shopId, input) {
		const id = normalizeContactId(input);
		if (!id) return { success: false, message: "Invalid contact ID." };
		return save(shopId, list(shopId).filter((contact) => contact.id !== id));
	}

	async function isExcluded(shopId, message, sock) {
		let excluded = new Set(list(shopId).map((contact) => contact.id));
		if (!excluded.size) return false;
		const jids = [message.key?.remoteJid, message.key?.remoteJidAlt].filter((id) => typeof id === "string");
		if (jids.some((jid) => excluded.has(normalizeContactId(jid)))) return true;

		const mapping = sock.signalRepository?.lidMapping;
		for (const jid of jids) {
			const id = normalizeContactId(jid);
			const lid = id?.endsWith("@lid");
			if (!id || !(lid ? [...excluded].some((e) => e.startsWith("+")) : [...excluded].some((e) => e.endsWith("@lid")))) continue;
			const resolve = lid ? mapping?.getPNForLID : mapping?.getLIDForPN;
			if (!resolve) continue;
			try {
				const alias = await resolve.call(mapping, jid);
				excluded = new Set(list(shopId).map((contact) => contact.id));
				if (excluded.has(normalizeContactId(alias))) return true;
			} catch {
				// An unavailable mapping cannot turn an opaque LID into a phone number.
			}
		}
		return jids.some((jid) => excluded.has(normalizeContactId(jid)));
	}

	return { list, add, remove, isExcluded };
}

module.exports = { createExcludedContacts, normalizeContactId };
