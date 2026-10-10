// The AI chat WhatsApp ordering flow. Customers send their files, then say how
// to print them in their own words ("saab ko color mein", "pehla page color,
// baqi black white"). The backend's inference endpoint turns that into
// structured changes, and the app answers like a shopkeeper would: a short
// summary with the total, then "confirm" moves on to paying. Cash on pickup is
// offered only under the shop's COD limit (as in the mobile app); otherwise the
// customer pays the shop's account online and sends a screenshot, which is
// attached as the draft's paymentProofFile before it's submitted. Instructions
// that aren't print settings ("staple kar dena") become additionalComments.
//
// One of two flows being tried out (the other is whatsappMenuFlow.js); dropping
// it means deleting this file and its entry in whatsapp.js's FLOWS.
//
// LLM calls are kept to messages that need one: file receipts, keywords
// (confirm / cancel / yes-words), thanks and emoji never reach it, and
// the shared incoming handler sends the first-message welcome without an LLM call.
//
// Its draft entries (see whatsappOrders.js) look like:
//   { flow: "chat", draftId, customer,
//     files: [{ file, name, numberOfPages,
//               runs: [{ from, to, print, settings, duplex }] }],  // pages in order
//     awaiting,   // null; "confirm" once the total has been shown; "payment"
//                 // while choosing cash or online; "proof" while waiting for
//                 // the payment screenshot (the next file is that screenshot)
//     total,      // the total last shown
//     payment,    // { codOk, codLimit, wallet }, from the shop at confirm time
//     additionalComments, paymentProofFile,  // sent with the draft when set
//     language,   // "en" | "roman_urdu" | "urdu": what replies are written in
//     history,    // the last few turns, for follow-ups like "nahi, dono"
//     batch }     // names of files received but not yet acknowledged
//
// A run's `settings` are the backend's (minus pageSelection); `duplex` is the
// customer's explicit flip edge, or null to follow the orientation; `print`
// false means those pages are left out (their settings are kept for if they're
// put back).

const { DEFAULT_SETTINGS, MAX_COPIES, autoDuplex, code } = require("./whatsappSettings");
const { normalize, rupees } = require("./whatsappOrders");
const { removalOf, pickupQuestion, paymentAnswer } = require("./whatsappChatCommands");

const FLOW = "chat";
const HISTORY_TURNS = 6;
const MAX_PARTS = 20; // runs per file the backend accepts as context

// ── Words handled without the LLM ─────────────────────────────────────────────

const CONFIRM_WORDS = new Set(["confirm"]);
const CANCEL_WORDS = new Set(["cancel", "cancel karo", "cancel kardo", "cancel kar do", "close session", "end session", "start over", "new order", "naya order", "نیا آرڈر"]);
// Only mean "go ahead" once a total is waiting for an answer.
const YES_WORDS = new Set([
	"yes", "y", "yep", "ok", "okay", "haan", "han", "ha", "ji", "jee", "g", "done",
	"theek", "theek hai", "thik hai", "theek ha", "sahi", "sahi hai",
	"ہاں", "جی", "ٹھیک ہے", "👍", "✅", "👌",
]);
// How the customer wants to pay, once asked.
const CASH_WORDS = new Set(["cash", "naqad", "nakad", "cop", "cod", "pickup", "نقد", "کیش"]);
const ONLINE_WORDS = new Set(["online", "transfer", "bank", "jazzcash", "easypaisa", "sadapay", "nayapay", "آن لائن", "آنلائن"]);

// "cash", "online", or null when the message says neither (or both).
function paymentChoice(word) {
	const tokens = word.split(/[\s,]+/);
	const cash = tokens.some((t) => CASH_WORDS.has(t));
	const online = tokens.some((t) => ONLINE_WORDS.has(t)) || /آن ?لائن/.test(word);
	return cash === online ? null : cash ? "cash" : "online";
}

// Acknowledgements that never need reading: silence unless they confirm.
const ACK_WORDS = new Set([
	"thanks", "thank you", "thankyou", "thx", "ty", "shukriya", "shukria", "jazakallah", "jazak allah", "شکریہ",
]);

// Lowercased, trimmed, trailing punctuation and emoji skin tones removed.
function wordOf(text) {
	return normalize(text).replace(/[\u{1F3FB}-\u{1F3FF}️]/gu, "").trim();
}

// Filler that can pad a yes ("ok please", "ji haan", "theek hai 👍").
const YES_FILLER = new Set(["hai", "please", "pls", "plz", "bhai", "g"]);

// A yes: one of the yes-words, or a few of them with filler ("Ok 👍").
function isYes(word) {
	if (YES_WORDS.has(word)) return true;
	const tokens = word.split(/\s+/).filter(Boolean);
	return tokens.length > 1 && tokens.length <= 4 && tokens.every((t) => YES_WORDS.has(t) || YES_FILLER.has(t))
		&& tokens.some((t) => YES_WORDS.has(t));
}

// Common Roman Urdu words that aren't also English ones ("is", "main" are left out).
const ROMAN_URDU = /\b(hai|hain|ka|ki|ke|ko|mein|karo|kardo|kar|sab|saab|baqi|baki|nahi|nai|haan|wala|wali|chahiye|chahie|pehla|pehli|dono|sirf|kitne|kaise|mujhe|aap|ye|yeh|iss)\b/i;

// A cheap guess at the language before the LLM has said: Urdu script, Roman
// Urdu by a few common words, else null (keep what we had).
function detectLanguage(text) {
	if (/[؀-ۿ]/.test(text)) return "urdu";
	if (ROMAN_URDU.test(text)) return "roman_urdu";
	return null;
}

// ── Reply templates ───────────────────────────────────────────────────────────

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const suffix = (message) => (message ? `: ${message}` : "");

// The online-payment instructions as three messages: what to do, the shop's
// account, then the account number alone so it's easy to copy on a phone.
const payMessages = (instructions, wallet) => [instructions, `${wallet.bank}\n${wallet.title}`, String(wallet.number)];

// The "job submitted" message: a heading, a blank line, then the code and total.
const placedText = (heading, codeLine, totalLine) => [heading, "", ...[codeLine, totalLine].filter(Boolean)].join("\n");

const T = {
	en: {
		welcome: (shop, assistant = "AI") => `I am ClickPrint ${assistant} of *${shop}*, send a document to continue.`,
		expired: "Your previous draft expired after 10 minutes of inactivity. Its files are no longer in your order. Send a document to start a new order.",
		expiredAdded: "Your previous draft expired after 10 minutes of inactivity. This document starts a new order.",
		pickup: "Collect at the shop counter.",
		cashPickup: "*Cash on Pickup*: pay and collect at the shop counter.",
		cashLimit: (limit) => `Cash on Pickup is available for orders below ${rupees(limit)}.`,
		onlineAvailable: "You can also pay online by bank transfer and send a screenshot of the payment confirmation.",
		onlineRequired: "Cash on Pickup isn't available for this order. Online payment is required before submission.",
		cashDisabled: "Cash on Pickup is disabled for this shop. Online payment is required.",
		whichRemove: "Which document should I remove? Reply with its number or filename:",
		removed: (names) => `Removed from your order: ${names.map(code).join(", ")}.`,
		removedAll: "All documents have been removed and the draft is closed. Send a document to start a new order.",
		kept: "Your documents are unchanged.",
		color: "color", bw: "B&W", single: "single-sided", double: "double-sided",
		landscape: "landscape", portrait: "portrait", perSheet: (n) => `${n} per sheet`,
		copies: (n) => plural(n, "copy", "copies"),
		page: (p) => `page ${p}`, pages: (p) => `pages ${p}`, only: "only",
		flip: (edge) => `flip on ${edge} edge`,
		received: (one) =>
			`Print settings for ${one ? "this file" : "these files"}?\n` +
			"Default is *A4, black & white, double-sided*\n" +
			"Reply with your print settings, or *confirm* to use the default.",
		done: "Done ✅", yourOrder: "Your order:",
		total: (t) => `*Total: ${rupees(t)}*`,
		confirmHint: "Reply *confirm* to place your order.",
		placed: (codeText, total) =>
			placedText("Your job has been submitted!", codeText && `Job code: *#${codeText}*`, total != null && `Total cost: Rs.${total}`),
		payHow: "How would you like to pay?\n• *cash*: Cash on Pickup\n• *online*: pay now by bank transfer\n\ncollect at the shop counter",
		payOnline: (amount, wallet, limit) =>
			payMessages(
				(limit != null ? `Orders of ${rupees(limit)} or more are paid online.\n` : "") +
					`Transfer *${rupees(amount)}* to the *${wallet.bank}* account,\nAnd then send a screenshot of the payment confirmation.`,
				wallet
			),
		proofReminder: "Please send a screenshot of your payment to place your order.",
		shopFailed: "Sorry, I couldn't load the payment options. Please reply *confirm* to try again.",
		paymentUnavailable: "Cash on pickup isn't available for this order and the shop hasn't configured online payment. Please contact the shop. Your order has not been submitted. Reply *confirm* to try again.",
		cancelled: "Your order has been cancelled.",
		cancelCheck: "Reply *cancel* to cancel your order.",
		noOrder: "Send me the files you want printed first.",
		noOrderToCancel: "You don't have an order to cancel.",
		didntGet: "Sorry, I didn't get that. Try e.g. *all color, double sided, 2 copies*",
		nothingLeft: "That would leave nothing to print. Tell me which pages you want.",
		addFailed: (name, m) => `Sorry, I couldn't add ${code(name)} to your order${suffix(m)}. Please send it again.`,
		updateFailed: (m) => `Sorry, I couldn't update your order${suffix(m)}. Please try again.`,
		priceFailed: (m) => `Sorry, I couldn't work out your total${suffix(m)}. Please reply *confirm* to try again.`,
		submitFailed: (m) => `Sorry, I couldn't place your order${suffix(m)}. Please reply *confirm* to try again.`,
		cancelFailed: (m) => `Sorry, I couldn't cancel your order${suffix(m)}. Please reply *cancel* to try again.`,
		gone: "Sorry, I couldn't find your order anymore. Please send your files again.",
	},
	roman_urdu: {
		welcome: (shop, assistant = "AI") => `Main *${shop}* ka ClickPrint ${assistant} hoon, aage barhne ke liye document bhejen.`,
		expired: "10 minute koi activity na hone par aap ka pichla draft expire ho gaya. Purani files ab order mein nahi hain. Naya order shuru karne ke liye document bhejen.",
		expiredAdded: "10 minute koi activity na hone par pichla draft expire ho gaya. Is document se naya order shuru hua hai.",
		pickup: "Shop counter se collect karen.",
		cashPickup: "*Cash on Pickup*: shop counter par payment karen aur prints collect karen.",
		cashLimit: (limit) => `Cash on Pickup ${rupees(limit)} se kam ke orders ke liye available hai.`,
		onlineAvailable: "Aap bank transfer se online payment bhi kar sakte hain aur payment confirmation ka screenshot bhej sakte hain.",
		onlineRequired: "Is order ke liye Cash on Pickup available nahi hai. Order submit karne se pehle online payment zaroori hai.",
		cashDisabled: "Is shop par Cash on Pickup band hai. Online payment zaroori hai.",
		whichRemove: "Kaunsa document remove karna hai? Us ka number ya filename likhen:",
		removed: (names) => `Order se remove kar diya: ${names.map(code).join(", ")}.`,
		removedAll: "Tamam documents remove ho gaye aur draft band ho gaya. Naya order shuru karne ke liye document bhejen.",
		kept: "Aap ke documents mein koi tabdeeli nahi hui.",
		color: "color", bw: "black & white", single: "single side", double: "double side",
		landscape: "landscape", portrait: "portrait", perSheet: (n) => `${n} per sheet`,
		copies: (n) => plural(n, "copy", "copies"),
		page: (p) => `page ${p}`, pages: (p) => `pages ${p}`, only: "sirf",
		flip: (edge) => `${edge} edge se flip`,
		received: (one) =>
			`${one ? "Is file" : "In files"} ki print settings?\n` +
			"Default hai *A4, black & white, double side*\n" +
			"Apni print settings likhen, ya default ke liye *confirm* likhen.",
		done: "Theek hai ✅", yourOrder: "Aap ka order:",
		total: (t) => `*Total: ${rupees(t)}*`,
		confirmHint: "Order dene ke liye *confirm* likhen.",
		placed: (codeText, total) =>
			placedText("Aap ki job submit ho gayi hai!", codeText && `Job code: *#${codeText}*`, total != null && `Total cost: Rs.${total}`),
		payHow: "Payment kaise karenge?\n• *cash*: Cash on Pickup\n• *online*: abhi bank transfer\n\nshop counter se collect karen",
		payOnline: (amount, wallet, limit) =>
			payMessages(
				(limit != null ? `${rupees(limit)} ya us se zyada ke orders ki payment online hoti hai.\n` : "") +
					`*${rupees(amount)}* is *${wallet.bank}* account mein transfer karen,\nAur phir payment confirmation ka screenshot bhejen.`,
				wallet
			),
		proofReminder: "Order lagane ke liye payment ka screenshot bhejen.",
		shopFailed: "Maaf kijiye, payment options load nahi ho sake. Dobara *confirm* likhen.",
		paymentUnavailable: "Is order ke liye cash on pickup available nahi hai aur shop ne online payment set nahi ki. Shop se rabta karen. Aap ka order submit nahi hua. Dobara koshish ke liye *confirm* likhen.",
		cancelled: "Aap ka order cancel kar diya gaya hai.",
		cancelCheck: "Order cancel karna hai to *cancel* likhen.",
		noOrder: "Pehle wo files bhejen jo print karni hain.",
		noOrderToCancel: "Aap ka koi order nahi hai.",
		didntGet: "Maaf kijiye, samajh nahi aaya. Jaise likhen: *sab color, double side, 2 copies*",
		nothingLeft: "Is tarah kuch bhi print nahi hoga. Batayen kaunse pages chahiye.",
		addFailed: (name, m) => `Maaf kijiye, ${code(name)} order mein add nahi ho saki${suffix(m)}. Dobara bhejen.`,
		updateFailed: (m) => `Maaf kijiye, order update nahi ho saka${suffix(m)}. Dobara koshish karen.`,
		priceFailed: (m) => `Maaf kijiye, total nahi nikal saka${suffix(m)}. Dobara *confirm* likhen.`,
		submitFailed: (m) => `Maaf kijiye, order nahi lag saka${suffix(m)}. Dobara *confirm* likhen.`,
		cancelFailed: (m) => `Maaf kijiye, order cancel nahi ho saka${suffix(m)}. Dobara *cancel* likhen.`,
		gone: "Maaf kijiye, aap ka order nahi mila. Files dobara bhejen.",
	},
	urdu: {
		welcome: (shop, assistant = "AI") => `میں *${shop}* کا ClickPrint ${assistant} ہوں، آگے بڑھنے کے لیے دستاویز بھیجیں۔`,
		expired: "10 منٹ کوئی سرگرمی نہ ہونے پر آپ کا پچھلا ڈرافٹ ختم ہو گیا۔ پرانی فائلیں اب آرڈر میں شامل نہیں ہیں۔ نیا آرڈر شروع کرنے کے لیے دستاویز بھیجیں۔",
		expiredAdded: "10 منٹ کوئی سرگرمی نہ ہونے پر پچھلا ڈرافٹ ختم ہو گیا۔ اس دستاویز سے نیا آرڈر شروع ہوا ہے۔",
		pickup: "دکان کے کاؤنٹر سے وصول کریں۔",
		cashPickup: "*Cash on Pickup*: دکان کے کاؤنٹر پر ادائیگی کریں اور پرنٹس وصول کریں۔",
		cashLimit: (limit) => `${rupees(limit)} سے کم کے آرڈرز کے لیے Cash on Pickup دستیاب ہے۔`,
		onlineAvailable: "آپ بینک ٹرانسفر کے ذریعے آن لائن ادائیگی بھی کر سکتے ہیں اور ادائیگی کی تصدیق کا اسکرین شاٹ بھیج سکتے ہیں۔",
		onlineRequired: "اس آرڈر کے لیے Cash on Pickup دستیاب نہیں ہے۔ آرڈر جمع کرنے سے پہلے آن لائن ادائیگی ضروری ہے۔",
		cashDisabled: "اس دکان پر Cash on Pickup بند ہے۔ آن لائن ادائیگی ضروری ہے۔",
		whichRemove: "کون سی دستاویز ہٹانی ہے؟ اس کا نمبر یا فائل کا نام لکھیں:",
		removed: (names) => `آرڈر سے ہٹا دیا: ${names.map(code).join("، ")}۔`,
		removedAll: "تمام دستاویزات ہٹا دی گئیں اور ڈرافٹ بند ہو گیا۔ نیا آرڈر شروع کرنے کے لیے دستاویز بھیجیں۔",
		kept: "آپ کی دستاویزات میں کوئی تبدیلی نہیں ہوئی۔",
		color: "رنگین", bw: "بلیک اینڈ وائٹ", single: "ایک طرف", double: "دونوں طرف",
		landscape: "لینڈ اسکیپ", portrait: "پورٹریٹ", perSheet: (n) => `ایک شیٹ پر ${n}`,
		copies: (n) => `${n} کاپی`,
		page: (p) => `صفحہ ${p}`, pages: (p) => `صفحات ${p}`, only: "صرف",
		flip: (edge) => (edge === "short" ? "چھوٹے کنارے سے پلٹیں" : "لمبے کنارے سے پلٹیں"),
		received: (one) =>
			`${one ? "اس فائل" : "ان فائلوں"} کی پرنٹ سیٹنگز؟\n` +
			"ڈیفالٹ ہے *A4، بلیک اینڈ وائٹ، دونوں طرف*\n" +
			"اپنی پرنٹ سیٹنگز لکھیں، یا ڈیفالٹ کے لیے *confirm* لکھیں۔",
		done: "ٹھیک ہے ✅", yourOrder: "آپ کا آرڈر:",
		total: (t) => `*کل: ${rupees(t)}*`,
		confirmHint: "آرڈر کے لیے *confirm* لکھیں۔",
		placed: (codeText, total) =>
			placedText("آپ کی جاب جمع ہو گئی ہے!", codeText && `جاب کوڈ: *#${codeText}*`, total != null && `کل لاگت: Rs.${total}`),
		payHow: "ادائیگی کیسے کریں گے؟\n• *cash*: Cash on Pickup\n• *online*: ابھی بینک ٹرانسفر\n\nدکان کے کاؤنٹر سے وصول کریں",
		payOnline: (amount, wallet, limit) =>
			payMessages(
				(limit != null ? `${rupees(limit)} یا اس سے زیادہ کے آرڈرز کی ادائیگی آن لائن ہوتی ہے۔\n` : "") +
					`*${rupees(amount)}* اس *${wallet.bank}* اکاؤنٹ میں ٹرانسفر کریں،\nاور پھر ادائیگی کی تصدیق کا اسکرین شاٹ بھیجیں۔`,
				wallet
			),
		proofReminder: "آرڈر لگانے کے لیے ادائیگی کا اسکرین شاٹ بھیجیں۔",
		shopFailed: "معذرت، ادائیگی کے آپشنز لوڈ نہیں ہو سکے۔ دوبارہ *confirm* لکھیں۔",
		paymentUnavailable: "اس آرڈر کے لیے وصولی پر نقد ادائیگی دستیاب نہیں اور دکان نے آن لائن ادائیگی ترتیب نہیں دی۔ دکان سے رابطہ کریں۔ آپ کا آرڈر جمع نہیں ہوا۔ دوبارہ کوشش کے لیے *confirm* لکھیں۔",
		cancelled: "آپ کا آرڈر منسوخ کر دیا گیا ہے۔",
		cancelCheck: "آرڈر منسوخ کرنا ہے تو *cancel* لکھیں۔",
		noOrder: "پہلے وہ فائلیں بھیجیں جو پرنٹ کرنی ہیں۔",
		noOrderToCancel: "آپ کا کوئی آرڈر نہیں ہے۔",
		didntGet: "معذرت، سمجھ نہیں آیا۔ مثلاً لکھیں: *سب رنگین، دونوں طرف، 2 کاپیاں*",
		nothingLeft: "اس طرح کچھ بھی پرنٹ نہیں ہو گا۔ بتائیں کون سے صفحات چاہییں۔",
		addFailed: (name, m) => `معذرت، ${code(name)} آرڈر میں شامل نہیں ہو سکی${suffix(m)}۔ دوبارہ بھیجیں۔`,
		updateFailed: (m) => `معذرت، آرڈر اپ ڈیٹ نہیں ہو سکا${suffix(m)}۔ دوبارہ کوشش کریں۔`,
		priceFailed: (m) => `معذرت، کل رقم نہیں نکل سکی${suffix(m)}۔ دوبارہ *confirm* لکھیں۔`,
		submitFailed: (m) => `معذرت، آرڈر نہیں لگ سکا${suffix(m)}۔ دوبارہ *confirm* لکھیں۔`,
		cancelFailed: (m) => `معذرت، آرڈر منسوخ نہیں ہو سکا${suffix(m)}۔ دوبارہ *cancel* لکھیں۔`,
		gone: "معذرت، آپ کا آرڈر نہیں ملا۔ فائلیں دوبارہ بھیجیں۔",
	},
};

function textsFor(language) {
	return T[language] || T.en;
}

// ── Per-page settings ─────────────────────────────────────────────────────────

// A file's runs when every page prints with the same settings.
function wholeFile(pages, settings = DEFAULT_SETTINGS) {
	const { pageSelection, ...rest } = settings;
	return [{ from: 1, to: pages, print: true, settings: { ...rest }, duplex: null }];
}

// Identity of a page's settings, for merging runs and grouping draft entries.
function slotKey({ print, settings: s, duplex }) {
	return JSON.stringify([print, s.color, s.pageType, s.pagesPerSheet, s.numberOfCopies, s.sidedness, s.orientation, duplex]);
}

// runs → one slot per page, { print, settings, duplex }.
function expand(runs) {
	const slots = [];
	for (const run of runs) {
		for (let p = run.from; p <= run.to; p++) {
			slots.push({ print: run.print, settings: { ...run.settings }, duplex: run.duplex });
		}
	}
	return slots;
}

// slots → runs of consecutive pages with identical slots.
function compress(slots) {
	const runs = [];
	slots.forEach((slot, i) => {
		const last = runs[runs.length - 1];
		if (last && slotKey(last) === slotKey(slot)) last.to = i + 1;
		else runs.push({ from: i + 1, to: i + 1, ...slot });
	});
	return runs;
}

// "1,3-5" → the 0-based pages it names within a file of `count` pages; "" = all.
function pageIndexes(pages, count) {
	if (!pages) return new Set(Array.from({ length: count }, (_, i) => i));
	const out = new Set();
	for (const part of String(pages).split(",")) {
		const [from, to = from] = part.split("-").map(Number);
		if (!Number.isInteger(from) || !Number.isInteger(to)) continue;
		for (let p = Math.max(from, 1); p <= Math.min(to, count); p++) out.add(p - 1);
	}
	return out;
}

// Applies one change from the inference result to a file of the order.
// Settings changes apply to the named pages; `only` leaves every other page
// out. Naming specific pages puts them back if they'd been left out.
function applyChange(file, change) {
	const slots = expand(file.runs);
	const targets = pageIndexes(change.pages, slots.length);
	if (change.only) slots.forEach((slot, i) => (slot.print = targets.has(i)));

	for (const i of targets) {
		const slot = slots[i];
		if (!slot.print && change.pages) slot.print = true;
		const s = slot.settings;
		if (change.color != null) s.color = change.color;
		if (change.pageType != null) s.pageType = change.pageType;
		if (change.orientation != null) s.orientation = change.orientation;
		if (change.pagesPerSheet != null) s.pagesPerSheet = change.pagesPerSheet;
		if (change.copies != null) s.numberOfCopies = Math.min(Math.max(change.copies, 1), MAX_COPIES);
		if (change.duplex != null) slot.duplex = change.duplex;
		// Sides as in the menu flow: an explicit flip edge sticks, otherwise
		// double-sided follows the (possibly new) orientation.
		const double = change.sides != null ? change.sides === "double" : change.duplex != null || s.sidedness !== "none";
		s.sidedness = double ? slot.duplex ?? autoDuplex(s) : "none";
	}
	return { ...file, runs: compress(slots) };
}

// Applies the inference result's changes, in order, to the order's files.
function applyChanges(files, changes) {
	let next = files;
	for (const change of changes) {
		const targets = change.files?.length ? new Set(change.files.map((n) => n - 1)) : null;
		next = next.map((file, i) => (!targets || targets.has(i) ? applyChange(file, change) : file));
	}
	return next;
}

// Printed pages grouped by identical settings: [{ key, slot, pages: [1-based] }].
function printedGroups(file) {
	const groups = new Map();
	expand(file.runs).forEach((slot, i) => {
		if (!slot.print) return;
		const key = slotKey(slot);
		if (!groups.has(key)) groups.set(key, { key, slot, pages: [] });
		groups.get(key).pages.push(i + 1);
	});
	return [...groups.values()];
}

// [1,2,3,5,8,9] → "1-3,5,8-9".
function rangesOf(pages) {
	const parts = [];
	for (let i = 0; i < pages.length; i++) {
		const start = pages[i];
		while (pages[i + 1] === pages[i] + 1) i++;
		parts.push(start === pages[i] ? String(start) : `${start}-${pages[i]}`);
	}
	return parts.join(",");
}

// Each file's printed groups, in the order their draft entries are sent — which
// is also the order of the backend's cost lines: [{ file, groups }].
function filesWithGroups(entry) {
	return entry.files.map((file) => ({ file, groups: printedGroups(file) }));
}

// The backend's draft files: one entry per distinct group of settings in each
// file, with the pages it covers ("" when that's the whole file). A file with
// nothing left to print has no entries.
function toDraftFiles(entry) {
	const out = [];
	for (const { file, groups } of filesWithGroups(entry)) {
		const pageCount = expand(file.runs).length;
		for (const group of groups) {
			const pageSelection = group.pages.length === pageCount ? "" : rangesOf(group.pages);
			out.push({ file: file.file, settings: { ...group.slot.settings, pageSelection } });
		}
	}
	return out;
}

// The file as the inference endpoint sees it: its runs in the model's words.
function toContextFile(file) {
	const count = expand(file.runs).length;
	return {
		name: file.name,
		pages: count,
		parts: file.runs.slice(0, MAX_PARTS).map((run) => ({
			pages: run.from === 1 && run.to === count ? "" : run.from === run.to ? String(run.from) : `${run.from}-${run.to}`,
			print: run.print,
			color: run.settings.color,
			pageType: run.settings.pageType,
			sides: run.settings.sidedness === "none" ? "single" : "double",
			duplex: run.settings.sidedness === "none" ? null : run.settings.sidedness,
			orientation: run.settings.orientation,
			pagesPerSheet: run.settings.pagesPerSheet,
			copies: run.settings.numberOfCopies,
		})),
	};
}

// ── Summaries ─────────────────────────────────────────────────────────────────

// The describable settings of a slot, in display order. `changed` marks the
// ones that differ from the defaults (A4, black & white, double-sided with the
// orientation's flip edge, portrait, 1 per sheet, 1 copy): only those are worth
// mentioning when every page of a file shares them.
function attributes(slot, t) {
	const s = slot.settings;
	const double = s.sidedness !== "none";
	return [
		{ key: "pageType", label: s.pageType, changed: s.pageType !== DEFAULT_SETTINGS.pageType },
		{ key: "color", label: s.color ? t.color : t.bw, changed: s.color !== DEFAULT_SETTINGS.color },
		{ key: "sides", label: double ? t.double : t.single, changed: !double },
		{ key: "duplex", label: double ? t.flip(s.sidedness) : "", changed: double && s.sidedness !== autoDuplex(s) },
		{ key: "orientation", label: s.orientation === "landscape" ? t.landscape : t.portrait, changed: s.orientation !== DEFAULT_SETTINGS.orientation },
		{ key: "pagesPerSheet", label: t.perSheet(s.pagesPerSheet), changed: s.pagesPerSheet !== DEFAULT_SETTINGS.pagesPerSheet },
		{ key: "copies", label: t.copies(s.numberOfCopies), changed: s.numberOfCopies !== DEFAULT_SETTINGS.numberOfCopies },
	];
}

const costText = (line) => `${line.item}: ${line.quantity} × ${rupees(line.rate)} = ${rupees(line.subtotal)}`;

// One bullet per file, with the settings the customer changed from the
// defaults, and the cost of each of its parts on the lines below:
//   • `notes.pdf` (2 copies)
//     page 1 color — A4 Color: 2 × Rs. 10 = Rs. 20
//     pages 2-12 B&W — A4 B&W: 12 × Rs. 4 = Rs. 48
// `lines` are the backend's cost lines, one per draft entry in toDraftFiles'
// order; without them (a count mismatch) the costs are left out.
function describeFile(file, groups, lines, t) {
	const pageCount = expand(file.runs).length;
	const pagesLabel = (pages) => (pages.length === 1 ? t.page(pages[0]) : t.pages(rangesOf(pages)));

	const perGroup = groups.map((g) => attributes(g.slot, t));
	const isCommon = (i) => perGroup.every((attrs) => attrs[i].label === perGroup[0][i].label);
	const common = perGroup[0].filter((attr, i) => isCommon(i) && attr.changed).map((a) => a.label);
	const head = `• ${code(file.name)}${common.length ? ` (${common.join(", ")})` : ""}`;

	const parts = groups.map((group, g) => {
		const whole = group.pages.length === pageCount;
		const varying = perGroup[g].filter((attr, i) => !isCommon(i) && attr.label).map((a) => a.label);
		const label = whole ? "" : [groups.length === 1 ? `${t.only} ${pagesLabel(group.pages)}` : pagesLabel(group.pages), ...varying].join(" ");
		const cost = lines ? costText(lines[g]) : "";
		const text = label && cost ? `${label} — ${cost}` : label || cost;
		return text ? `   ${text}` : null;
	});
	return [head, ...parts.filter(Boolean)].join("\n");
}

// The whole order: every file with its costs, extra charges, then the total.
function describeOrder(entry, cost, t) {
	const files = filesWithGroups(entry).filter(({ groups }) => groups.length > 0);
	const entries = files.reduce((n, { groups }) => n + groups.length, 0);
	const lines = cost?.lines?.length === entries ? cost.lines : null;

	let next = 0;
	const blocks = files.map(({ file, groups }) => {
		const own = lines ? lines.slice(next, (next += groups.length)) : null;
		return describeFile(file, groups, own, t);
	});
	const extras = (cost?.extra || []).map((e) => `• ${e.item}: ${rupees(e.subtotal)}`);
	return [...blocks, ...extras].join("\n");
}

// ── The flow ──────────────────────────────────────────────────────────────────

const MAX_COMMENTS = 500; // the draft's additionalComments limit

// core: the order core from whatsappOrders.js; api: { inferSettings, fetchShop }.
function createChatFlow(core, api) {
	const { keyOf, getEntry, setEntry } = core;

	function remember(entry, customerText, reply) {
		const history = [...(entry.history || [])];
		if (customerText) history.push({ from: "customer", text: customerText.slice(0, 500) });
		if (reply) history.push({ from: "shop", text: [].concat(reply).join("\n\n").slice(0, 200) });
		return { ...entry, history: history.slice(-HISTORY_TURNS) };
	}

	// Adds an uploaded file to the customer's draft, creating it on their first
	// file. Replies once per batch: while more of their files are still being
	// uploaded (`morePending`) it stays quiet and remembers the file. While a
	// payment screenshot is awaited, the file is that screenshot instead.
	async function addFile(shopId, customer, file, name = file.name, { morePending = false, messageId } = {}) {
		const key = keyOf(shopId, customer.number);
		const { expired } = core.prepare(key);
		const previous = getEntry(key);
		if (previous?.awaiting === "proof") return attachProof(shopId, key, previous, file);

		const pages = file.numberOfPages || 1;
		const entry = {
			...previous,
			flow: FLOW,
			draftId: previous?.draftId ?? null,
			customer,
			files: [...(previous?.files || []), { file: file._id, name, numberOfPages: pages, runs: wholeFile(pages), messageId }],
			awaiting: null,
			language: previous?.language || "en",
			history: previous?.history || [],
			batch: [...(previous?.batch || []), name],
			focusedFiles: [file._id],
			pendingRemoval: false,
			sessionExpired: expired || previous?.sessionExpired,
			payment: null,
			cashPayment: false,
			paymentProofFile: previous?.paymentProofFile ? null : undefined,
		};
		const t = textsFor(entry.language);

		const saved = await core.push(shopId, key, entry, toDraftFiles(entry));
		if (!saved.ok) return t.addFailed(name, saved.message);
		console.log(`[Drafts] ${customer.number}: draft now has ${entry.files.length} file(s)`);
		if (morePending) return null;
		return acknowledge(key, saved.entry);
	}

	// The reply for files received but not yet acknowledged, or null.
	function flush(shopId, customer) {
		const key = keyOf(shopId, customer.number);
		const entry = getEntry(key);
		return entry?.batch?.length ? acknowledge(key, entry) : null;
	}

	// Asks for the print settings of the files just received (no need to echo
	// their names back: the reply quotes the customer's last file).
	function acknowledge(key, entry) {
		const t = textsFor(entry.language);
		const reply = [entry.sessionExpired && t.expiredAdded, t.received((entry.batch || []).length <= 1)].filter(Boolean).join("\n\n");
		setEntry(key, { ...remember(entry, null, reply), batch: [], sessionExpired: false });
		return reply;
	}

	// Handles a text message. Returns the reply, or null to stay silent.
	async function handleText(shopId, customer, text, { quotedMessageId } = {}) {
		const key = keyOf(shopId, customer.number);
		const { expired } = core.prepare(key);
		let entry = getEntry(key);
		const word = wordOf(text);
		const guess = detectLanguage(text);

		if (!entry) {
			if (expired) return textsFor(guess).expired;
			if (CONFIRM_WORDS.has(word)) return textsFor(guess).noOrder;
			if (CANCEL_WORDS.has(word)) return textsFor(guess).noOrderToCancel;
			if (pickupQuestion(text)) return pickupInfo(key, null, text);
			return null;
		}
		if (guess && guess !== entry.language) {
			entry = { ...entry, language: guess };
			setEntry(key, entry);
		}

		if (CANCEL_WORDS.has(word)) return cancel(key, entry);
		const removal = removalOf(text, entry, entry.pendingRemoval);
		if (removal) {
			if (removal.keep) return reply(key, { ...entry, pendingRemoval: false }, text, textsFor(entry.language).kept);
			if (removal.clarify) {
				const list = entry.files.map((file, i) => `${i + 1}. ${code(file.name)}`).join("\n");
				return reply(key, { ...entry, pendingRemoval: true }, text, `${textsFor(entry.language).whichRemove}\n${list}`);
			}
			return removeFiles(shopId, key, entry, text, removal.indices);
		}
		const quoted = quotedMessageId && entry.files.find((file) => file.messageId === quotedMessageId);
		if (quoted) entry = { ...entry, focusedFiles: [quoted.file] };
		if (pickupQuestion(text) && (!inPayment(entry) || !paymentAnswer(text))) return pickupInfo(key, entry, text);

		// Choosing how to pay, or sending the payment screenshot: the choice and
		// the usual yes-words are understood without the LLM.
		if (entry.awaiting === "payment" || entry.awaiting === "proof") {
			const choice = paymentAnswer(text) ? paymentChoice(word) : null;
			if (choice === "cash" && entry.payment?.codOk) return placeOrder(key, { ...entry, cashPayment: true });
			if (choice === "online" && entry.awaiting === "payment") return askProof(key, entry, text);
			if (choice) return paymentPrompt(key, entry, text);
			if (CONFIRM_WORDS.has(word) || isYes(word)) return paymentPrompt(key, entry, text);
		} else if (CONFIRM_WORDS.has(word) || (entry.awaiting === "confirm" && isYes(word))) {
			return confirm(shopId, key, entry, text);
		}
		// A question about cash or pickup must not itself confirm the order.
		if (pickupQuestion(text)) return pickupInfo(key, entry, text);
		if (isYes(word) || ACK_WORDS.has(word)) return null;
		if (!/[\p{L}\p{N}]/u.test(text)) return null;

		return understand(shopId, key, entry, text);
	}

	async function pickupInfo(key, entry, text) {
		const t = textsFor(entry?.language || detectLanguage(text));
		const shop = await api.fetchShop();
		if (!shop?.success || !shop.data) return entry ? reply(key, entry, text, `${t.pickup}\n${t.shopFailed}`) : `${t.pickup}\n${t.shopFailed}`;
		const limit = shop.data.codLimit;
		const cash = typeof limit === "number" && limit > 0 && (entry?.total == null || Number(entry.total) < limit);
		const wallet = !!shop.data.wallet?.number;
		const guidance = cash ? t.cashLimit(limit) : !wallet ? t.paymentUnavailable : typeof limit === "number" && limit > 0 ? t.onlineRequired : t.cashDisabled;
		const message = [t.pickup, guidance, cash && wallet && t.onlineAvailable, !entry && t.noOrder].filter(Boolean).join("\n\n");
		return entry ? reply(key, entry, text, message) : message;
	}

	async function removeFiles(shopId, key, entry, text, indices) {
		const t = textsFor(entry.language);
		const targets = new Set(indices);
		const removed = entry.files.filter((_, i) => targets.has(i));
		const remaining = entry.files.filter((_, i) => !targets.has(i));
		if (!remaining.length) {
			const result = await core.remove(key, entry);
			return result.ok ? t.removedAll : reply(key, entry, text, t.updateFailed(result.message));
		}
		const next = { ...entry, files: remaining, awaiting: null, total: null, payment: null, cashPayment: false, paymentProofFile: null, pendingRemoval: false, batch: [], history: [], focusedFiles: [] };
		const saved = await core.push(shopId, key, next, toDraftFiles(next));
		if (!saved.ok) return reply(key, entry, text, t.updateFailed(saved.message));
		return showTotal(shopId, key, saved.entry, text, t.removed(removed.map((file) => file.name)));
	}

	// Asks the backend to read the message and acts on what it found.
	async function understand(shopId, key, entry, text) {
		const result = await api.inferSettings({
			shop: shopId,
			message: text.slice(0, 1000),
			files: entry.files.map(toContextFile),
			history: entry.history || [],
		});
		if (!result?.success || !result.data) {
			console.error(`[Chat] inference failed (${result?.status ?? "network"}):`, result?.message);
			return reply(key, entry, text, textsFor(entry.language).didntGet);
		}

		const { intent, language, changes = [], question, comment } = result.data;
		const current = withComment({ ...entry, language: T[language] ? language : entry.language }, comment);
		const t = textsFor(current.language);
		console.log(`[Chat] ${entry.customer.number}: ${intent} (${changes.length} change(s)${comment ? ", comment" : ""})`);

		switch (intent) {
			case "settings":
				if (!changes.length && !comment) return reply(key, current, text, question || t.didntGet);
				return changeSettings(shopId, key, current, text, changes);
			case "price":
				return showTotal(shopId, key, current, text, t.yourOrder);
			case "confirm": {
				if (!comment) return confirm(shopId, key, current, text);
				// Save the instruction first; a confirm after it has changed is
				// still a confirm, since comments don't change the price.
				const saved = await core.push(shopId, key, current, toDraftFiles(current));
				if (!saved.ok) return reply(key, entry, text, t.updateFailed(saved.message));
				return confirm(shopId, key, saved.entry, text);
			}
			case "cancel":
				return reply(key, current, text, t.cancelCheck);
			case "unclear":
				if (inPayment(current)) return paymentPrompt(key, current, text);
				return reply(key, current, text, question || t.didntGet);
			default: // offtopic: leave it to the shopkeeper, unless a payment step is waiting
				if (inPayment(current)) return paymentPrompt(key, current, text);
				setEntry(key, remember(current, text, null));
				return null;
		}
	}

	const inPayment = (entry) => entry.awaiting === "payment" || entry.awaiting === "proof";

	// Adds an instruction for the shop to the order's comments.
	function withComment(entry, comment) {
		if (!comment) return entry;
		const all = [entry.additionalComments, comment].filter(Boolean).join("\n");
		return { ...entry, additionalComments: all.slice(-MAX_COMMENTS) };
	}

	// Saves the turn to the history and returns the reply.
	function reply(key, entry, customerText, text) {
		setEntry(key, remember(entry, customerText, text));
		return text;
	}

	async function changeSettings(shopId, key, entry, text, changes) {
		const t = textsFor(entry.language);
		const focusedFiles = changes.length ? entry.files.filter((_, i) => changes.some((change) => !change.files?.length || change.files.includes(i + 1))).map((file) => file.file) : entry.focusedFiles;
		const next = { ...entry, files: applyChanges(entry.files, changes), awaiting: null, payment: null, cashPayment: false, paymentProofFile: null, pendingRemoval: false, focusedFiles };
		const files = toDraftFiles(next);
		if (files.length === 0) return reply(key, entry, text, t.nothingLeft);

		const saved = await core.push(shopId, key, next, files);
		if (!saved.ok) return reply(key, entry, text, t.updateFailed(saved.message));
		return showTotal(shopId, key, saved.entry, text, t.done);
	}

	// Prices the order and shows it; the next "confirm" (or yes) moves on to paying.
	async function showTotal(shopId, key, entry, text, heading) {
		const t = textsFor(entry.language);
		const priced = await core.price(shopId, key, entry, toDraftFiles(entry));
		if (!priced.ok) return reply(key, { ...entry, awaiting: null }, text, t.priceFailed(priced.message));
		const note = priced.entry.additionalComments ? `📝 ${priced.entry.additionalComments}` : null;
		const summary = [heading, describeOrder(priced.entry, priced.cost, t), note, `${t.total(priced.cost.total)}\n${t.confirmHint}`]
			.filter(Boolean).join("\n\n");
		return reply(key, { ...priced.entry, awaiting: "confirm", total: priced.cost.total }, text, summary);
	}

	// Once the total has been shown, confirming moves on to paying; otherwise
	// the total is shown first.
	async function confirm(shopId, key, entry, text) {
		const t = textsFor(entry.language);
		if (inPayment(entry)) return paymentPrompt(key, entry, text);
		if (entry.awaiting !== "confirm") return showTotal(shopId, key, entry, text, t.yourOrder);
		return choosePayment(key, entry, text);
	}

	// Cash on pickup is offered only when the shop has a COD limit and the total
	// is under it (as in the mobile app); otherwise the order is paid online to
	// the shop's wallet, with a screenshot as proof.
	async function choosePayment(key, entry, text) {
		const t = textsFor(entry.language);
		const shop = await api.fetchShop();
		if (!shop?.success || !shop.data) {
			console.error("[Chat] couldn't load the shop for payment options:", shop?.message);
			return reply(key, entry, text, t.shopFailed);
		}
		const codLimit = typeof shop.data.codLimit === "number" ? shop.data.codLimit : null;
		const { bank, title, number } = shop.data.wallet || {};
		const wallet = number ? { bank: bank || "", title: title || "", number } : null;
		const codOk = codLimit != null && Number(entry.total) < codLimit;
		const next = { ...entry, payment: { codOk, codLimit, wallet }, cashPayment: false };

		if (codOk && wallet) return reply(key, { ...next, awaiting: "payment" }, text, t.payHow);
		if (wallet) return askProof(key, next, text);
		if (codOk) return placeOrder(key, { ...next, cashPayment: true });
		return reply(key, entry, text, t.paymentUnavailable);
	}

	// The shop's account details, and a request for the payment screenshot.
	function askProof(key, entry, text) {
		const t = textsFor(entry.language);
		const { codOk, codLimit, wallet } = entry.payment;
		const message = t.payOnline(entry.total, wallet, codOk ? null : codLimit);
		return reply(key, { ...entry, awaiting: "proof", cashPayment: false }, text, message);
	}

	// Repeats whatever the payment step is waiting for.
	function paymentPrompt(key, entry, text) {
		const t = textsFor(entry.language);
		return reply(key, entry, text, entry.awaiting === "payment" ? t.payHow : t.proofReminder);
	}

	// The payment screenshot arrived: attach it and place the order.
	async function attachProof(shopId, key, entry, file) {
		const t = textsFor(entry.language);
		const saved = await core.push(shopId, key, { ...entry, paymentProofFile: file._id }, toDraftFiles(entry));
		if (!saved.ok) return t.updateFailed(saved.message);
		return placeOrder(key, saved.entry);
	}

	async function placeOrder(key, entry) {
		const t = textsFor(entry.language);
		const result = await core.submit(key, entry);
		if (result.ok) {
			const { code: orderCode, cost } = result.job;
			return `${t.placed(orderCode, cost?.total)}\n\n${entry.cashPayment ? t.cashPickup : t.pickup}`;
		}
		if (result.gone) return t.gone;
		return reply(key, entry, null, t.submitFailed(result.message));
	}

	async function cancel(key, entry) {
		const t = textsFor(entry.language);
		const result = await core.remove(key, entry);
		return result.ok ? t.cancelled : t.cancelFailed(result.message);
	}

	return { addFile, handleText, flush };
}

module.exports = {
	createChatFlow,
	// Exposed for tests.
	detectLanguage,
	wholeFile,
	applyChanges,
	toDraftFiles,
	toContextFile,
	describeOrder,
	T,
};
