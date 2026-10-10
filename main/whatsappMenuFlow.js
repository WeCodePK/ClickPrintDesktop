// The numbered-menu WhatsApp flow: file settings, order review, then payment.
// Job-list numbers are routed through the shared ownership/cancellation handler.
// Drafts and payment proofs use the same order core as the AI chat.
const {
	DEFAULT_SETTINGS, code, num, settingByKey, menuItems, fileDetails,
	settingsMenu, settingPrompt, parseSettingAnswer, filePrompt, fileSummary,
} = require("./whatsappSettings");
const { normalize, plural, costLines } = require("./whatsappOrders");
const { T } = require("./whatsappChatFlow");

const FLOW = "menu";
const CONFIRM = "confirm";
const CANCEL = "cancel";
const MENU = "menu";
const t = T.en;
const MAIN_MENU_HINT = "Press *0* to go back to the main menu.";

// Keep account numbers in their own copyable message when adding navigation.
function withNavigation(reply) {
	if (!reply) return reply;
	const texts = [].concat(reply).map((text) => String(text)
		.replace(/or \*0\* to go back\./g, "or *0* to go back to the main menu.")
		.replace(/Reply \*0\* to change settings\./g, MAIN_MENU_HINT));
	const body = texts.join("\n");
	const isMainMenu = texts[0].startsWith("*Main menu*\n");
	if (!isMainMenu && !(body.includes("*0*") && /main menu|مرکزی مینو/i.test(body))) texts[0] += "\n\n" + MAIN_MENU_HINT;
	return Array.isArray(reply) ? texts : texts[0];
}

function menuWord(text) {
	return normalize(String(text).normalize("NFKC")
		.replace(/[۰-۹٠-٩]/g, (digit) => String(digit.charCodeAt(0) - (digit >= "۰" ? 0x6f0 : 0x660)))
		.replace(/[\uFE0F\u20E3]/g, ""));
}

function draftFiles(entry) {
	return entry.files.map(({ file, settings }) => ({ file, settings }));
}

function createMenuFlow(core, api, jobs) {
	const { keyOf, getEntry, setEntry } = core;

	function push(shopId, key, entry) {
		return core.push(shopId, key, entry, draftFiles(entry));
	}

	async function homeMenu(shopId, customer, { greeting = false, canHandle = async () => true } = {}) {
		const key = keyOf(shopId, customer.number);
		let available;
		try { available = await jobs?.menuAvailability(shopId, customer, canHandle); }
		catch (error) { console.error("[Menu] could not load current jobs:", error.message); }
		if (available?.aborted || !await canHandle()) return null;
		const actions = [];
		if (available?.hasJobs) actions.push("list");
		if (available?.canCancel) actions.push("cancel");
		const hasDraft = !!getEntry(key);
		if (hasDraft) actions.push("settings");
		core.mainMenuActions(key, actions);
		if (greeting && available && !available.failed && !actions.length) return "";
		const labels = { list: "List current jobs", cancel: "Cancel a job", settings: "Print settings" };
		return withNavigation([
			"*Main menu*",
			(!available || available.failed) && "I couldn\'t load your jobs right now. Press *0* to try again.",
			...actions.map((action, i) => num(i + 1) + " " + labels[action]),
			hasDraft ? "Reply with a number to continue." : actions.length ? "Reply with a number, or send a document to start an order." : "Send a document to start an order.",
		].filter(Boolean).join("\n\n"));
	}

	// Only numbers from a displayed main menu can open job management.
	function jobAction(shopId, customer, text) {
		const word = menuWord(text);
		if (!/^\d+$/.test(word)) return null;
		const action = core.mainMenuActions(keyOf(shopId, customer.number))?.[Number(word) - 1];
		return action === "list" || action === "cancel" ? action : null;
	}

	function menuReply(entry, heading = "📄") {
		const file = entry.files[entry.selected];
		const details = fileDetails(file, entry.selected, entry.files.length);
		return [
			heading + " " + code(file.name) + (details ? "\n" + details : ""),
			"Reply with a number to change a setting\n" + settingsMenu(file, entry.files.length),
			"Reply with *confirm* or *cancel*",
		].join("\n\n");
	}

	// Any change to print contents/settings invalidates the priced/payment step.
	// Clear an attached proof on the backend before returning to order editing.
	function withoutPayment(entry) {
		return {
			...entry, awaiting: null, total: null, payment: null, cashPayment: false,
			paymentProofFile: entry.paymentProofFile ? null : entry.paymentProofFile,
		};
	}

	async function addFile(shopId, customer, file, name = file.name) {
		const key = keyOf(shopId, customer.number);
		core.mainMenuActions(key, null);
		const { expired } = core.prepare(key);
		const previous = getEntry(key);
		if (previous?.awaiting === "proof") return attachProof(shopId, key, previous, file);

		// A completed order has no open draft. Its next upload starts a new order.
		const files = [
			...(previous?.files || []),
			{ file: file._id, settings: { ...DEFAULT_SETTINGS }, name, numberOfPages: file.numberOfPages ?? null, duplex: null },
		];
		const entry = withoutPayment({
			...previous, flow: FLOW, draftId: previous?.draftId ?? null,
			customer, files, selected: files.length - 1,
		});
		const saved = await push(shopId, key, entry);
		if (!saved.ok) return t.addFailed(name, saved.message);
		console.log("[Drafts] " + customer.number + ": draft now has " + files.length + " file(s)");
		return [expired && t.expiredAdded, menuReply(saved.entry, "✅ Added to your order")].filter(Boolean).join("\n\n");
	}

	async function handleText(shopId, customer, text, { canHandle = async () => true } = {}) {
		const key = keyOf(shopId, customer.number);
		core.prepare(key);
		const word = menuWord(text);
		if (word === MENU || word === "0") return homeMenu(shopId, customer, { canHandle });
		if (word === CONFIRM || word === CANCEL) {
			core.mainMenuActions(key, null);
			return word === CONFIRM ? confirm(shopId, customer) : cancel(shopId, customer);
		}

		const entry = getEntry(key);
		const actions = core.mainMenuActions(key);
		if (actions && /^\d+$/.test(word)) {
			if (actions[Number(word) - 1] === "settings" && entry) {
				core.mainMenuActions(key, null);
				return back(shopId, key, entry);
			}
			return homeMenu(shopId, customer, { canHandle });
		}
		if (!entry) return null;
		if (actions) core.mainMenuActions(key, null);
		if (entry.awaiting === "payment" || entry.awaiting === "proof") return answerPayment(key, entry, word);
		if (entry.awaiting === "file") return pickFile(shopId, key, entry, word);
		if (entry.awaiting && entry.awaiting !== CONFIRM) return answerSetting(shopId, key, entry, word);
		if (/^\d+$/.test(word)) return menuChoice(shopId, key, entry, Number(word));
		return null;
	}

	async function back(shopId, key, entry) {
		const reset = withoutPayment(entry);
		if (entry.paymentProofFile) return saveAndShow(shopId, key, reset, "📄");
		setEntry(key, reset);
		return menuReply(reset);
	}

	async function menuChoice(shopId, key, entry, n) {
		const file = entry.files[entry.selected];
		const items = menuItems(file, entry.files.length);
		const item = items[n - 1];
		if (!item) return "Please reply with a number from 1 to " + items.length + ".";
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

	function pickFile(shopId, key, entry, word) {
		const index = /^\d+$/.test(word) ? Number(word) - 1 : -1;
		if (!entry.files[index]) return "Please reply with a number from 1 to " + entry.files.length + ", or *0* to go back.";
		const picked = { ...entry, selected: index, awaiting: null };
		setEntry(key, picked);
		return menuReply(picked);
	}

	async function answerSetting(shopId, key, entry, word) {
		const setting = settingByKey(entry.awaiting);
		const file = entry.files[entry.selected];
		if (!setting?.apply || !file) return back(shopId, key, entry);
		const parsed = parseSettingAnswer(setting, word, file);
		if (parsed.error) return parsed.error;
		return changeFile(shopId, key, entry, setting, setting.apply(file, parsed.value));
	}

	function changeFile(shopId, key, entry, setting, changed) {
		const files = entry.files.map((f, i) => (i === entry.selected ? changed : f));
		return saveAndShow(shopId, key, { ...entry, files }, "✅ " + setting.label + " changed to *" + setting.show(changed) + "* for");
	}

	async function saveAndShow(shopId, key, entry, heading) {
		const saved = await push(shopId, key, withoutPayment(entry));
		if (!saved.ok) return t.updateFailed(saved.message);
		return menuReply(saved.entry, heading);
	}

	// First confirm shows the price; the next opens payment, never bypassing
	// the shop's COD limit when a wallet is missing.
	async function confirm(shopId, customer) {
		const key = keyOf(shopId, customer.number);
		const entry = getEntry(key);
		if (!entry) return t.noOrder;
		if (entry.awaiting === "proof" && entry.paymentProofFile) return placeOrder(key, entry);
		if (entry.awaiting === "payment" || entry.awaiting === "proof") return paymentPrompt(entry);
		if (entry.awaiting !== CONFIRM || !Number.isFinite(entry.total)) return review(shopId, key, entry);
		return choosePayment(key, entry);
	}

	async function review(shopId, key, entry) {
		const priced = await core.price(shopId, key, entry, draftFiles(entry));
		if (!priced.ok || !Number.isFinite(priced.cost?.total) || priced.cost.total < 0) return t.priceFailed(priced.message);
		const current = { ...priced.entry, awaiting: CONFIRM, total: priced.cost.total, payment: null, cashPayment: false };
		setEntry(key, current);
		const files = current.files.map((f, i) => num(i + 1) + " " + fileSummary(f)).join("\n");
		return [
			"*Your order* (" + plural(current.files.length, "file") + ")\n" + files,
			costLines(priced.cost),
			t.confirmHint,
		].join("\n\n");
	}

	async function choosePayment(key, entry) {
		let shop;
		try { shop = await api?.fetchShop(); }
		catch (error) { console.error("[Menu] couldn't load payment options:", error.message); }
		if (!shop?.success || !shop.data) return t.shopFailed;
		const codLimit = Number.isFinite(shop.data.codLimit) && shop.data.codLimit > 0 ? shop.data.codLimit : null;
		const { bank, title, number } = shop.data.wallet || {};
		const wallet = number && String(number).trim() ? { bank: bank || "", title: title || "", number } : null;
		const codOk = codLimit != null && Number.isFinite(entry.total) && entry.total >= 0 && entry.total < codLimit;
		const next = { ...entry, payment: { codOk, codLimit, wallet }, cashPayment: false };
		if (codOk) {
			setEntry(key, { ...next, awaiting: "payment" });
			return paymentPrompt(next);
		}
		if (wallet) return askProof(key, next);
		return t.paymentUnavailable;
	}

	function paymentPrompt(entry) {
		if (entry.awaiting === "proof") return t.proofReminder + "\nReply *0* to change settings.";
		const options = [];
		if (entry.payment?.codOk) options.push("1️⃣ Cash on Pickup");
		if (entry.payment?.wallet) options.push("2️⃣ Prepaid order: pay now by bank transfer");
		if (!options.length) return t.paymentUnavailable;
		return "How would you like to pay?\n" + options.join("\n") + "\n\ncollect at the shop counter\nReply *0* to change settings.";
	}

	function answerPayment(key, entry, word) {
		const cash = new Set(["1", "cash", "cash on pickup", "cop", "cod"]).has(word);
		const prepaid = new Set(["2", "prepaid", "prepaid order", "online", "bank transfer", "transfer"]).has(word);
		if (cash && entry.payment?.codOk) {
			// Switching away from an attached proof must also clear it on the backend.
			if (entry.paymentProofFile) return switchToCash(key, entry);
			return placeOrder(key, { ...entry, cashPayment: true });
		}
		if (prepaid && entry.payment?.wallet) return askProof(key, entry);
		if (cash && !entry.payment?.codOk) return t.onlineRequired + "\n\n" + paymentPrompt(entry);
		return paymentPrompt(entry);
	}

	async function switchToCash(key, entry) {
		const shopId = key.slice(0, key.indexOf(":"));
		const saved = await push(shopId, key, { ...entry, paymentProofFile: null, cashPayment: true, awaiting: "payment" });
		return saved.ok ? placeOrder(key, saved.entry) : t.updateFailed(saved.message);
	}

	function askProof(key, entry) {
		if (!entry.payment?.wallet) return t.paymentUnavailable;
		const { codOk, codLimit, wallet } = entry.payment;
		setEntry(key, { ...entry, awaiting: "proof", cashPayment: false });
		return t.payOnline(entry.total, wallet, codOk ? null : codLimit);
	}

	async function attachProof(shopId, key, entry, file) {
		const saved = await push(shopId, key, { ...entry, paymentProofFile: file._id, cashPayment: false });
		if (!saved.ok) return t.updateFailed(saved.message);
		return placeOrder(key, saved.entry);
	}

	async function placeOrder(key, entry) {
		const cashAllowed = entry.cashPayment && entry.payment?.codOk &&
			Number.isFinite(entry.total) && entry.total >= 0 && entry.total < entry.payment.codLimit;
		if (!entry.paymentProofFile && !cashAllowed) return t.paymentUnavailable;
		setEntry(key, entry);
		const result = await core.submit(key, entry);
		if (result.ok) {
			return t.placed(result.job.code, result.job.cost?.total) + "\n\n" + (cashAllowed ? t.cashPickup : t.pickup);
		}
		if (result.gone) return t.gone;
		return t.submitFailed(result.message);
	}

	async function cancel(shopId, customer) {
		const key = keyOf(shopId, customer.number);
		const entry = getEntry(key);
		if (!entry) return t.noOrderToCancel;
		const result = await core.remove(key, entry);
		return result.ok ? t.cancelled : t.cancelFailed(result.message);
	}

	return {
		addFile: async (...args) => withNavigation(await addFile(...args)),
		handleText: async (...args) => withNavigation(await handleText(...args)),
		homeMenu, jobAction, withNavigation,
	};
}

module.exports = { createMenuFlow };
