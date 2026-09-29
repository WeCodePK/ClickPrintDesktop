// A WhatsApp customer's order-in-progress. Every document a customer sends is
// added to one backend draft (created on their first document) with the default
// print settings, and they get a numbered menu of that file's settings. Replying
// with a number flips a two-way setting or asks for the new value. "confirm"
// shows the order with its total, a second "confirm" submits it as a job, and
// "cancel" deletes it.
//
// The backend has no lookup for a customer's draft, so the app remembers it per
// shop + customer number, persisted through the injected load/save:
//   { draftId, customer,
//     files: [{ file, settings, name, numberOfPages, duplex }],
//     selected,   // index of the file the menu is showing
//     awaiting }  // null (menu), "file" (picking a file), a setting key
//                 // (answering its prompt) or "confirm" (total shown)
//
// No Electron imports — the API calls and storage are injected, so this runs
// under plain `node --test`.

const {
	DEFAULT_SETTINGS,
	code,
	num,
	settingByKey,
	menuItems,
	fileDetails,
	settingsMenu,
	settingPrompt,
	parseSettingAnswer,
	filePrompt,
	fileSummary,
} = require("./whatsappSettings");

const CONFIRM = "confirm";
const CANCEL = "cancel";
const MENU = "menu";

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


function draftKey(shopId, number) {
	return `${shopId}:${number}`;
}

// api: { createDraft, updateDraft, checkDraft, submitDraft, deleteDraft }, each
// resolving { success, status, message, data } with data the draft (or job, for
// submit). load() returns the saved drafts map; save(map) persists it.
function createDraftManager({ api, load, save }) {
	function getEntry(key) {
		return load()[key] || null;
	}

	function setEntry(key, entry) {
		const drafts = load();
		if (entry) drafts[key] = entry;
		else delete drafts[key];
		save(drafts);
	}

	// Sends the entry's files to the backend: updates its draft, or creates one
	// when it has none yet or the old one is gone (404). Saves the entry, with its
	// draftId, only on success. Returns { ok, entry } (the saved entry) or
	// { ok: false, message }.
	async function pushDraft(shopId, key, entry) {
		const body = {
			source: "shop",
			channel: "whatsapp",
			shop: shopId,
			customer: entry.customer,
			files: entry.files.map(({ file, settings }) => ({ file, settings })),
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

	// The settings menu for the selected file. `heading` leads its first line,
	// followed by the filename: "✅ Added to your order `a.pdf`".
	function menuReply(entry, heading = "📄") {
		const file = entry.files[entry.selected];
		const details = fileDetails(file, entry.selected, entry.files.length);
		return [
			`${heading} ${code(file.name)}${details ? `\n${details}` : ""}`,
			`Reply with a number to change a setting\n${settingsMenu(file, entry.files.length)}`,
			`Reply with *${CONFIRM}* or *${CANCEL}*`,
		].join("\n\n");
	}

	// Adds an uploaded file (the backend's File object) to the customer's draft,
	// creating the draft on their first file. Returns the reply for the customer.
	async function addFile(shopId, customer, file, name = file.name) {
		const key = draftKey(shopId, customer.number);
		const previous = getEntry(key);
		const files = [
			...(previous?.files || []),
			{ file: file._id, settings: { ...DEFAULT_SETTINGS }, name, numberOfPages: file.numberOfPages ?? null, duplex: null },
		];
		const entry = { draftId: previous?.draftId ?? null, customer, files, selected: files.length - 1, awaiting: null };

		const saved = await pushDraft(shopId, key, entry);
		if (!saved.ok) {
			return `Sorry, we couldn't add ${code(name)} to your order${saved.message ? `: ${saved.message}` : "."} Please send it again.`;
		}
		console.log(`[Drafts] ${customer.number}: draft now has ${files.length} file(s)`);
		return menuReply(saved.entry, "✅ Added to your order");
	}

	// Handles a text message from a customer. Returns the reply, or null when the
	// message isn't meant for the order flow (the customer has no draft, or it's
	// ordinary chat while the menu is showing).
	async function handleText(shopId, customer, text) {
		const word = normalize(text);
		if (word === CONFIRM) return confirm(shopId, customer);
		if (word === CANCEL) return cancel(shopId, customer);

		const key = draftKey(shopId, customer.number);
		const entry = getEntry(key);
		if (!entry) return null;

		if (word === MENU) return back(key, entry);
		if (entry.awaiting === "file") return pickFile(key, entry, word);
		if (entry.awaiting && entry.awaiting !== CONFIRM) return answerSetting(shopId, key, entry, word);
		if (/^\d+$/.test(word)) return menuChoice(shopId, key, entry, Number(word));
		return null;
	}

	// Back to the menu, dropping whatever was being asked.
	function back(key, entry) {
		const reset = { ...entry, awaiting: null };
		setEntry(key, reset);
		return menuReply(reset);
	}

	async function menuChoice(shopId, key, entry, n) {
		const file = entry.files[entry.selected];
		const items = menuItems(file, entry.files.length);
		const item = items[n - 1];
		if (!item) return `Please reply with a number from 1 to ${items.length}, or *${MENU}* to see the settings again.`;

		if (item.action === "pickFile") {
			setEntry(key, { ...entry, awaiting: "file" });
			return filePrompt(entry.files, entry.selected);
		}
		if (item.action === "applyToAll") {
			const files = entry.files.map((f) => ({ ...f, settings: { ...file.settings }, duplex: file.duplex }));
			return saveAndShow(shopId, key, { ...entry, files }, "✅ Every file now uses the settings of");
		}
		const { setting } = item;
		if (setting.toggle) return changeFile(shopId, key, entry, setting, setting.toggle(file));
		setEntry(key, { ...entry, awaiting: setting.key });
		return settingPrompt(setting, file);
	}

	function pickFile(key, entry, word) {
		if (word === "0") return back(key, entry);
		const index = /^\d+$/.test(word) ? Number(word) - 1 : -1;
		if (!entry.files[index]) {
			return `Please reply with a number from 1 to ${entry.files.length}, or *0* to go back.`;
		}
		const picked = { ...entry, selected: index, awaiting: null };
		setEntry(key, picked);
		return menuReply(picked);
	}

	async function answerSetting(shopId, key, entry, word) {
		const setting = settingByKey(entry.awaiting);
		const file = entry.files[entry.selected];
		if (!setting?.apply || !file || word === "0") return back(key, entry);

		const parsed = parseSettingAnswer(setting, word, file);
		if (parsed.error) return parsed.error;
		return changeFile(shopId, key, entry, setting, setting.apply(file, parsed.value));
	}

	// Replaces the selected file with its changed version and saves the draft.
	function changeFile(shopId, key, entry, setting, changed) {
		const files = entry.files.map((f, i) => (i === entry.selected ? changed : f));
		const heading = `✅ ${setting.label} changed to *${setting.show(changed)}* for`;
		return saveAndShow(shopId, key, { ...entry, files }, heading);
	}

	// Pushes changed settings to the draft and shows the menu again. On failure
	// nothing is saved, so the customer can try the change again.
	async function saveAndShow(shopId, key, entry, heading) {
		const saved = await pushDraft(shopId, key, { ...entry, awaiting: null });
		if (!saved.ok) {
			setEntry(key, { ...getEntry(key), awaiting: null }); // the old settings stay
			return `Sorry, we couldn't update your order${saved.message ? `: ${saved.message}` : "."} Please try again.`;
		}
		return menuReply(saved.entry, heading);
	}

	// The first "confirm" prices the order and shows it; a second one, with
	// nothing changed in between, submits it.
	async function confirm(shopId, customer) {
		const key = draftKey(shopId, customer.number);
		const entry = getEntry(key);
		if (!entry) return "You don't have an order yet. Send us a document to start one.";
		if (entry.awaiting !== CONFIRM) return review(shopId, key, entry);
		return submit(key, entry, customer);
	}

	async function review(shopId, key, entry) {
		let current = entry;
		let check = await api.checkDraft(current.draftId);
		if (check?.status === 404) {
			// The draft is gone from the backend; the files are still known here.
			const saved = await pushDraft(shopId, key, current);
			if (saved.ok) {
				current = saved.entry;
				check = await api.checkDraft(current.draftId);
			}
		}
		if (!check?.success || !check.data?.cost) {
			console.error(`[Drafts] check of ${current.draftId} failed:`, check?.message);
			return `Sorry, we couldn't work out your total${check?.message ? `: ${check.message}` : "."} Please reply *${CONFIRM}* to try again.`;
		}
		setEntry(key, { ...current, awaiting: CONFIRM });

		const files = current.files.map((f, i) => `${num(i + 1)} ${fileSummary(f)}`).join("\n");
		return [
			`*Your order* (${plural(current.files.length, "file")})\n${files}`,
			costLines(check.data.cost),
			`• *${CONFIRM}* again to place your order\n• *${MENU}* to change something`,
		].join("\n\n");
	}

	async function submit(key, entry, customer) {
		const result = await api.submitDraft(entry.draftId);
		if (result?.success) {
			setEntry(key, null);
			const job = result.data || {};
			console.log(`[Drafts] ${customer.number}: draft ${entry.draftId} submitted as job ${job._id} (${job.code})`);
			const lines = ["Your order has been placed!"];
			if (job.code) lines.push(`Order code: *${job.code}*`);
			if (job.cost?.total != null) lines.push(`Total: ${rupees(job.cost.total)}`);
			return lines.join("\n");
		}
		if (result?.status === 404) {
			setEntry(key, null);
			return "Sorry, we couldn't find your order anymore. Please send your documents again.";
		}
		console.error(`[Drafts] submit of ${entry.draftId} failed:`, result?.message);
		return `Sorry, we couldn't place your order${result?.message ? `: ${result.message}` : "."} Please reply *${CONFIRM}* to try again.`;
	}

	// Deletes the customer's draft so their next document starts a new one. A
	// draft already gone from the backend (404) just gets forgotten; any other
	// failure keeps it, so "cancel" can be retried.
	async function cancel(shopId, customer) {
		const key = draftKey(shopId, customer.number);
		const entry = getEntry(key);
		if (!entry) return "You don't have an order to cancel.";

		const result = await api.deleteDraft(entry.draftId);
		if (!result?.success && result?.status !== 404) {
			console.error(`[Drafts] delete of ${entry.draftId} failed:`, result?.message);
			return `Sorry, we couldn't cancel your order${result?.message ? `: ${result.message}` : "."} Please reply *${CANCEL}* to try again.`;
		}
		setEntry(key, null);
		console.log(`[Drafts] ${customer.number}: draft ${entry.draftId} cancelled`);
		return "Your order has been cancelled. Send us a document to start a new one.";
	}

	return { addFile, handleText, confirm, cancel };
}

module.exports = { CONFIRM, CANCEL, MENU, textOf, createDraftManager };
