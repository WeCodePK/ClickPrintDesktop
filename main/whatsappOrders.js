// The order core shared by every WhatsApp ordering flow (see whatsappMenuFlow.js
// and whatsappChatFlow.js): remembering each customer's open draft and keeping
// the backend's copy in sync — create, update, price, submit, delete — plus the
// little text helpers both flows use. Nothing here decides what the customer is
// told; that's each flow's job.
//
// The backend has no lookup for a customer's draft, so the app remembers it per
// shop + customer number, persisted through the injected load/save. Every entry
// has at least { flow, draftId, customer }; the rest is the owning flow's own
// state. Entries saved before flows existed have no `flow` and are the menu's.
//
// No Electron imports — the API calls and storage are injected, so this runs
// under plain `node --test`.

// The text of a plain text message, or null.
function textOf(msg) {
	const content = msg?.message;
	const text = content?.conversation ?? content?.extendedTextMessage?.text;
	return typeof text === "string" ? text : null;
}

// Lowercased, trimmed, without trailing punctuation: "  Confirm! " → "confirm".
function normalize(text) {
	return String(text).trim().toLowerCase().replace(/[.!\s]+$/, "");
}

function rupees(amount) {
	return `Rs. ${Number(amount) || 0}`;
}

function plural(count, word) {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// The cost breakdown as WhatsApp text: one line per priced item, then the total.
function costLines(cost) {
	return [
		...(cost.lines || []).map((l) => `• ${l.item}: ${l.quantity} × ${rupees(l.rate)} = ${rupees(l.subtotal)}`),
		...(cost.extra || []).map((l) => `• ${l.item}: ${rupees(l.subtotal)}`),
		`*Total: ${rupees(cost.total)}*`,
	].join("\n");
}

// api: { createDraft, updateDraft, checkDraft, submitDraft, deleteDraft }, each
// resolving { success, status, message, data } with data the draft (or job, for
// submit). load() returns the saved drafts map; save(map) persists it.
function createOrderCore({ api, load, save }) {
	function keyOf(shopId, number) {
		return `${shopId}:${number}`;
	}

	function getEntry(key) {
		return load()[key] || null;
	}

	function setEntry(key, entry) {
		const drafts = load();
		if (entry) drafts[key] = entry;
		else delete drafts[key];
		save(drafts);
	}

	// Which flow owns the customer's open draft, or null when they have none.
	function flowOf(shopId, number) {
		const entry = getEntry(keyOf(shopId, number));
		return entry ? entry.flow || "menu" : null;
	}

	// Sends `files` (the backend's draft files array) to the entry's draft:
	// updates it, or creates one when it has none yet or the old one is gone
	// (404). An entry's additionalComments and paymentProofFile go along when it
	// has them. Saves the entry, with its draftId, only on success. Returns
	// { ok, entry } (the saved entry) or { ok: false, message }.
	async function push(shopId, key, entry, files) {
		const body = {
			source: "shop",
			channel: "whatsapp",
			shop: shopId,
			customer: entry.customer,
			files,
			...(entry.additionalComments != null && { additionalComments: entry.additionalComments }),
			...(entry.paymentProofFile != null && { paymentProofFile: entry.paymentProofFile }),
		};
		let result = entry.draftId ? await api.updateDraft(entry.draftId, body) : await api.createDraft(body);
		if (entry.draftId && result?.status === 404) {
			console.log(`[Drafts] draft ${entry.draftId} for ${entry.customer.number} is gone — creating a new one`);
			result = await api.createDraft(body);
		}
		const draftId = result?.data?._id ?? entry.draftId;
		if (!result?.success || !draftId) {
			console.error(`[Drafts] saving the draft for ${entry.customer.number} failed:`, result?.message);
			return { ok: false, message: result?.message };
		}
		const saved = { ...entry, draftId };
		setEntry(key, saved);
		return { ok: true, entry: saved };
	}

	// Prices the entry's draft. A draft gone from the backend is recreated from
	// `files` first. Returns { ok, entry, cost } or { ok: false, message }; the
	// entry itself isn't saved here beyond what a recreate needs.
	async function price(shopId, key, entry, files) {
		let current = entry;
		let check = await api.checkDraft(current.draftId);
		if (check?.status === 404) {
			const saved = await push(shopId, key, current, files);
			if (saved.ok) {
				current = saved.entry;
				check = await api.checkDraft(current.draftId);
			}
		}
		if (!check?.success || !check.data?.cost) {
			console.error(`[Drafts] check of ${current.draftId} failed:`, check?.message);
			return { ok: false, message: check?.message };
		}
		return { ok: true, entry: current, cost: check.data.cost };
	}

	// Submits the draft as a job and forgets it. Returns { ok, job }, or
	// { ok: false, gone } — gone when the backend no longer has the draft (it's
	// forgotten too), else with the backend's message and the entry kept.
	async function submit(key, entry) {
		const result = await api.submitDraft(entry.draftId);
		if (result?.success) {
			setEntry(key, null);
			const job = result.data || {};
			console.log(`[Drafts] ${entry.customer.number}: draft ${entry.draftId} submitted as job ${job._id} (${job.code})`);
			return { ok: true, job };
		}
		if (result?.status === 404) {
			setEntry(key, null);
			return { ok: false, gone: true };
		}
		console.error(`[Drafts] submit of ${entry.draftId} failed:`, result?.message);
		return { ok: false, gone: false, message: result?.message };
	}

	// Deletes the draft so the customer's next file starts a new one. A draft
	// already gone from the backend (404) is just forgotten; any other failure
	// keeps it, so the cancel can be retried. Returns { ok } or { ok: false, message }.
	async function remove(key, entry) {
		const result = await api.deleteDraft(entry.draftId);
		if (!result?.success && result?.status !== 404) {
			console.error(`[Drafts] delete of ${entry.draftId} failed:`, result?.message);
			return { ok: false, message: result?.message };
		}
		setEntry(key, null);
		console.log(`[Drafts] ${entry.customer.number}: draft ${entry.draftId} cancelled`);
		return { ok: true };
	}

	return { keyOf, getEntry, setEntry, flowOf, push, price, submit, remove };
}

module.exports = { textOf, normalize, rupees, plural, costLines, createOrderCore };
