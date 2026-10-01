// The numbered-menu WhatsApp ordering flow. Every file a customer sends is added
// to their draft with the default print settings, and they get a numbered menu
// of that file's settings. Replying with a number flips a two-way setting or
// asks for the new value. "confirm" shows the order with its total, a second
// "confirm" submits it as a job, and "cancel" deletes it.
//
// One of two flows being tried out (the other is whatsappChatFlow.js); dropping
// it means deleting this file and its entry in whatsapp.js's FLOWS.
//
// Its draft entries (see whatsappOrders.js) look like:
//   { flow: "menu", draftId, customer,
//     files: [{ file, settings, name, numberOfPages, duplex }],
//     selected,   // index of the file the menu is showing
//     awaiting }  // null (menu), "file" (picking a file), a setting key
//                 // (answering its prompt) or "confirm" (total shown)

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
const { normalize, rupees, plural, costLines } = require("./whatsappOrders");

const FLOW = "menu";
const CONFIRM = "confirm";
const CANCEL = "cancel";
const MENU = "menu";

// The backend's draft files for a menu entry: one per file, as-is.
function draftFiles(entry) {
	return entry.files.map(({ file, settings }) => ({ file, settings }));
}

// core: the order core from whatsappOrders.js.
function createMenuFlow(core) {
	const { keyOf, getEntry, setEntry } = core;

	function push(shopId, key, entry) {
		return core.push(shopId, key, entry, draftFiles(entry));
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
		const key = keyOf(shopId, customer.number);
		const previous = getEntry(key);
		const files = [
			...(previous?.files || []),
			{ file: file._id, settings: { ...DEFAULT_SETTINGS }, name, numberOfPages: file.numberOfPages ?? null, duplex: null },
		];
		const entry = { flow: FLOW, draftId: previous?.draftId ?? null, customer, files, selected: files.length - 1, awaiting: null };

		const saved = await push(shopId, key, entry);
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

		const key = keyOf(shopId, customer.number);
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
		const saved = await push(shopId, key, { ...entry, awaiting: null });
		if (!saved.ok) {
			setEntry(key, { ...getEntry(key), awaiting: null }); // the old settings stay
			return `Sorry, we couldn't update your order${saved.message ? `: ${saved.message}` : "."} Please try again.`;
		}
		return menuReply(saved.entry, heading);
	}

	// The first "confirm" prices the order and shows it; a second one, with
	// nothing changed in between, submits it.
	async function confirm(shopId, customer) {
		const key = keyOf(shopId, customer.number);
		const entry = getEntry(key);
		if (!entry) return "You don't have an order yet. Send us a document or photo to start one.";
		if (entry.awaiting !== CONFIRM) return review(shopId, key, entry);

		const result = await core.submit(key, entry);
		if (result.ok) {
			const lines = ["Your job has been submitted!", ""];
			if (result.job.code) lines.push(`Job code: *#${result.job.code}*`);
			if (result.job.cost?.total != null) lines.push(`Total cost: Rs.${result.job.cost.total}`);
			return lines.join("\n");
		}
		if (result.gone) return "Sorry, we couldn't find your order anymore. Please send your documents again.";
		return `Sorry, we couldn't place your order${result.message ? `: ${result.message}` : "."} Please reply *${CONFIRM}* to try again.`;
	}

	async function review(shopId, key, entry) {
		const priced = await core.price(shopId, key, entry, draftFiles(entry));
		if (!priced.ok) {
			return `Sorry, we couldn't work out your total${priced.message ? `: ${priced.message}` : "."} Please reply *${CONFIRM}* to try again.`;
		}
		const current = priced.entry;
		setEntry(key, { ...current, awaiting: CONFIRM });

		const files = current.files.map((f, i) => `${num(i + 1)} ${fileSummary(f)}`).join("\n");
		return [
			`*Your order* (${plural(current.files.length, "file")})\n${files}`,
			costLines(priced.cost),
			`• *${CONFIRM}* again to place your order\n• *${MENU}* to change something`,
		].join("\n\n");
	}

	async function cancel(shopId, customer) {
		const key = keyOf(shopId, customer.number);
		const entry = getEntry(key);
		if (!entry) return "You don't have an order to cancel.";
		const result = await core.remove(key, entry);
		if (!result.ok) {
			return `Sorry, we couldn't cancel your order${result.message ? `: ${result.message}` : "."} Please reply *${CANCEL}* to try again.`;
		}
		return "Your order has been cancelled. Send us a document or photo to start a new one.";
	}

	return { addFile, handleText };
}

module.exports = { createMenuFlow };
