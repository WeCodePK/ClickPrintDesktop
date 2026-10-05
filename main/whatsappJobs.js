const { detectLanguage } = require("./whatsappChatFlow");

const STORE_KEY = "whatsappJobSelections";
const SELECTION_MS = 10 * 60 * 1000;
const PAGE_SIZE = 6;
const CANCELLABLE = new Set(["submitted", "queued"]);
const JOB = /\bjobs?\b|جاب|جوب/;
const ORDER = /\borders?\b|آرڈر|ارڈر/;
const WORK = /\b(jobs?|orders?|prints?)\b|جاب|جوب|آرڈر|ارڈر|پرنٹ/;
const CANCEL = /\b(cancel|cancle|cansel|kensal|mansookh|mansukh)\b|منسوخ|کینسل/;
const LIST = /\b(list|show|display|view|see|tell|check|status|statuses|track|tracking|dikhao|dikha|dikhado|dikhayen|dekhao|batao|bata|batado|bta|btao|btado|batain|bataen|batayein|dikhaen)\b|دکھا|دکھاؤ|دکھائیں|بتا|فہرست|حالت|اسٹیٹس/;
const DOCUMENT = /\b(files?|documents?|pages?|copies|pdfs?|attachments?)\b|فائل|دستاویز|صفح|کاپی/;

function fold(text) {
	return String(text).normalize("NFKC").toLowerCase()
		.replace(/[۰-۹٠-٩]/g, (digit) => String(digit.charCodeAt(0) - (digit >= "۰" ? 0x6f0 : 0x660)))
		.replace(/[\u064b-\u065f\u0670]/g, "")
		.replace(/[‘’']/g, "").trim();
}

function languageOf(text, fallback = "en") {
	return detectLanguage(text) || (/\b(mera|meri|mere|meray|mery|kro|krdo|kardein|karden|karna|krna|dikhao|dikha|dikhayen|dekhao|batao|btao|batain|bataen|mansookh|mansukh|agla|pichla|mazeed)\b/i.test(text) ? "roman_urdu" : fallback);
}

function referenceOf(word) {
	const ids = word.match(/\b[0-9a-f]{24}\b/g) || [];
	const rest = word.replace(/\b[0-9a-f]{24}\b/g, "");
	const numbers = rest.match(/\b\d+\b/g) || [];
	if (ids.length + numbers.length > 1 || /(?:^|[\s(])[-+]\d/.test(rest)) return { invalid: true };
	if (ids.length === 1) return { id: ids[0] };
	if (numbers.length === 1) return numbers[0].length <= 4 ? { code: numbers[0].padStart(4, "0") } : { invalid: true };
	return null;
}

// Read-only questions and negations must never become a cancellation action.
function commandOf(word, hasDraft) {
	const reference = referenceOf(word);
	const explicitReference = reference?.id || (reference && /#|\b(id|code)\b|آئی ڈی|کوڈ/.test(word));
	const bareCancel = /^(?:please |pls |plz )?(?:cancel|mansookh|mansukh|منسوخ|کینسل)(?:\s+(?:kar do|kar dein|karo|kardo|krdo|kro|کر دو|کریں|کردیں))?[.!\s]*$/.test(word);
	if (CANCEL.test(word) && !DOCUMENT.test(word) && (WORK.test(word) || explicitReference || (!hasDraft && bareCancel))) {
		const direct = word.replace(/^(can|could|would) you (please )?/, "");
		if (/\b(dont|do not|never|mat|nahi|nahin)\b|نہیں|(?:^|\s)(مت|نہ)(?:\s|$)/.test(direct)) return { action: "keep" };
		if (/\b(can i|could i|may i|how|if|whether|should|kya|kaise|agar)\b|کیا|کیسے|اگر/.test(direct)) return { action: "rules" };
		// Without a job reference, "cancel my order" still closes an open draft.
		if (hasDraft && ORDER.test(word) && !JOB.test(word) && !reference) return null;
		return { action: "cancel", reference };
	}
	if (WORK.test(word) && (LIST.test(word) || /^(?:(my|mere|meri|meray|میرے|میری)\s+)?(jobs|orders|جابز|آرڈرز)[.!?؟\s]*$/.test(word))) return { action: "list" };
	return null;
}

const T = {
	en: {
		jobs: "Your jobs", cancelJobs: "Which job should I cancel?", job: "Job", documents: "Documents", submittedAt: "Submitted at", unavailable: "Unavailable", unnamedDocument: (n) => `Document ${n} (name unavailable)`, page: (p, n) => `Page ${p}/${n}`,
		statuses: { submitted: "Submitted", queued: "Queued", printing: "Printing", completed: "Completed", cancelled: "Cancelled", failed: "Failed" },
		noJobs: "You have no WhatsApp jobs at this shop.", noCancellable: "You have no submitted or queued jobs to cancel.",
		rules: "Only submitted or queued jobs can be cancelled. Jobs that have started printing cannot be cancelled.",
		select: "Reply with S.No. or #job ID to cancel. Reply *back* to exit.",
		listHint: "To cancel, reply *cancel #job-ID*.",
		next: "Reply *next* for more.", previous: "Reply *previous* to go back.",
		invalid: "Please choose one job using its S.No. or #job ID.",
		ambiguous: "That job ID matches multiple orders. Reply *cancel my job* and choose a S.No.",
		notFound: "I couldn't find that job among your WhatsApp orders at this shop.",
		printing: "That job has started printing and cannot be cancelled.",
		closed: (status) => `That job is ${status.toLowerCase()} and cannot be cancelled.`,
		cancelled: (label) => label ? `Job ${label} cancelled.` : "Your job was cancelled.", keep: "No job was cancelled.", back: "Job selection closed.",
		loadFailed: "I couldn't load your jobs. Please try again.",
		historyFailed: "History is unavailable; showing active jobs only.",
		cancelFailed: "I couldn't cancel that job. Please try again.",
		numberUnknown: "I couldn't verify your WhatsApp number. Please contact the shop.",
	},
	roman_urdu: {
		jobs: "Aap ki jobs", cancelJobs: "Kaunsi job cancel karni hai?", job: "Job", documents: "Documents", submittedAt: "Submit hui", unavailable: "Dastiyab nahi", unnamedDocument: (n) => `Document ${n} (naam dastiyab nahi)`, page: (p, n) => `Page ${p}/${n}`,
		statuses: { submitted: "Submit ho gayi", queued: "Queue mein", printing: "Print ho rahi hai", completed: "Mukammal", cancelled: "Cancel ho gayi", failed: "Fail ho gayi" },
		noJobs: "Is shop par aap ki koi WhatsApp job nahi hai.", noCancellable: "Cancel karne ke liye koi submitted ya queued job nahi hai.",
		rules: "Sirf submitted ya queued jobs cancel ho sakti hain. Printing shuru ho chuki ho to job cancel nahi ho sakti.",
		select: "Cancel karne ke liye S.No. ya #job ID bhejen. Wapas jane ke liye *back* likhen.",
		listHint: "Cancel karne ke liye *cancel #job-ID* likhen.",
		next: "Mazeed ke liye *next* likhen.", previous: "Pichle page ke liye *previous* likhen.",
		invalid: "Ek job ka S.No. ya #job ID bhejen.",
		ambiguous: "Is job ID se ek se zyada orders hain. *cancel my job* likhen aur S.No. chunen.",
		notFound: "Is shop par aap ki WhatsApp jobs mein yeh job nahi mili.",
		printing: "Is job ki printing shuru ho chuki hai, ab cancel nahi ho sakti.",
		closed: (status) => `Yeh job ${status} hai, cancel nahi ho sakti.`,
		cancelled: (label) => label ? `Job ${label} cancel ho gayi.` : "Aap ki job cancel ho gayi.", keep: "Koi job cancel nahi ki.", back: "Job selection band kar di.",
		loadFailed: "Jobs load nahi ho sakin. Dobara koshish karen.",
		historyFailed: "History nahi mil rahi; sirf active jobs dikha raha hoon.",
		cancelFailed: "Job cancel nahi ho saki. Dobara koshish karen.",
		numberUnknown: "Aap ka WhatsApp number verify nahi ho saka. Shop se rabta karen.",
	},
	urdu: {
		jobs: "آپ کی جابز", cancelJobs: "کون سی جاب منسوخ کرنی ہے؟", job: "جاب", documents: "دستاویزات", submittedAt: "جمع ہوئی", unavailable: "دستیاب نہیں", unnamedDocument: (n) => `دستاویز ${n} (نام دستیاب نہیں)`, page: (p, n) => `صفحہ ${p}/${n}`,
		statuses: { submitted: "جمع ہو گئی", queued: "قطار میں", printing: "پرنٹنگ جاری ہے", completed: "مکمل", cancelled: "منسوخ", failed: "ناکام" },
		noJobs: "اس دکان پر آپ کی کوئی واٹس ایپ جاب نہیں ہے۔", noCancellable: "منسوخ کرنے کے لیے کوئی جمع شدہ یا قطار میں موجود جاب نہیں ہے۔",
		rules: "صرف جمع شدہ یا قطار میں موجود جاب منسوخ ہو سکتی ہے۔ پرنٹنگ شروع ہو چکی ہو تو جاب منسوخ نہیں ہو سکتی۔",
		select: "منسوخ کرنے کے لیے فہرست کا نمبر یا #جاب آئی ڈی بھیجیں۔ واپس جانے کے لیے *back* لکھیں۔",
		listHint: "منسوخ کرنے کے لیے *cancel #job-ID* لکھیں۔",
		next: "مزید کے لیے *next* لکھیں۔", previous: "پچھلے صفحے کے لیے *previous* لکھیں۔",
		invalid: "ایک جاب کا فہرست نمبر یا #جاب آئی ڈی بھیجیں۔",
		ambiguous: "اس جاب آئی ڈی سے ایک سے زیادہ آرڈرز ہیں۔ *cancel my job* لکھیں اور فہرست سے نمبر منتخب کریں۔",
		notFound: "اس دکان پر آپ کی واٹس ایپ جابز میں یہ جاب نہیں ملی۔",
		printing: "اس جاب کی پرنٹنگ شروع ہو چکی ہے، اب منسوخ نہیں ہو سکتی۔",
		closed: (status) => `یہ جاب ${status} ہے، منسوخ نہیں ہو سکتی۔`,
		cancelled: (label) => label ? `جاب ${label} منسوخ کر دی۔` : "آپ کی جاب منسوخ کر دی۔", keep: "کوئی جاب منسوخ نہیں کی۔", back: "جاب کا انتخاب بند کر دیا۔",
		loadFailed: "جابز حاصل نہیں ہو سکیں۔ دوبارہ کوشش کریں۔",
		historyFailed: "ہسٹری دستیاب نہیں؛ صرف موجودہ جابز دکھا رہا ہوں۔",
		cancelFailed: "جاب منسوخ نہیں ہو سکی۔ دوبارہ کوشش کریں۔",
		numberUnknown: "آپ کا واٹس ایپ نمبر معلوم نہیں ہو سکا۔ دکان سے رابطہ کریں۔",
	},
};

function createWhatsAppJobs({ api, store, withStatuses = (jobs) => jobs, cancelJob }) {
	function keyOf(shopId, number) { return `${shopId}:${number}`; }
	function selections() {
		const saved = store.get(STORE_KEY);
		return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
	}
	function clear(shopId, number) {
		const saved = selections();
		const key = keyOf(shopId, number);
		if (saved[key]) { delete saved[key]; store.set(STORE_KEY, saved); }
	}
	function expireSelections() {
		const saved = selections();
		let changed = false;
		for (const [key, selection] of Object.entries(saved)) {
			if (!Number.isFinite(selection?.at) || Date.now() - selection.at >= SELECTION_MS) { delete saved[key]; changed = true; }
		}
		if (changed) store.set(STORE_KEY, saved);
	}
	function owned(job, shopId, number) {
		const shop = typeof job?.shop === "string" ? job.shop : job?.shop?._id;
		return job?.source === "shop" && job.channel === "whatsapp" && shop === shopId &&
			job.customer?.number === number && typeof job._id === "string" && /^[0-9a-f]{24}$/i.test(job._id);
	}
	function label(job) { return job.code ? `*#${job.code}*` : null; }
	function documentNames(job, t) {
		const seen = new Set();
		const names = [];
		for (const [i, entry] of (job.files || []).entries()) {
			const fileId = typeof entry.file === "string" ? entry.file : entry.file?._id || entry.fileId;
			// One file can have several entries for different page settings.
			if (fileId && seen.has(fileId)) continue;
			if (fileId) seen.add(fileId);
			const name = String(entry.file?.name || entry.name || entry.fileName || "").replace(/[\r\n`]/g, " ").trim();
			names.push(name ? `\`${name}\`` : t.unnamedDocument(i + 1));
		}
		return names.length ? names.join(", ") : t.unavailable;
	}
	function submittedAt(job, language, t) {
		const at = job.statusHistory?.find((entry) => entry.status === "submitted")?.at || job.createdAt;
		const date = at ? new Date(at) : null;
		if (!date || !Number.isFinite(date.getTime())) return t.unavailable;
		return `${new Intl.DateTimeFormat(language === "urdu" ? "ur-PK" : "en-PK", {
			timeZone: "Asia/Karachi", day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
		}).format(date)} PKT`;
	}
	function statusText(job, t) { return t.statuses[job.status] || job.status; }
	function closed(job, t) { return job.status === "printing" ? t.printing : t.closed(statusText(job, t)); }

	async function loadJobs(shopId, customer, history, canHandle) {
		if (!await canHandle()) return { aborted: true };
		const [active, archived] = await Promise.all([api.fetchJobs(), history ? api.fetchHistory() : null]);
		if (!await canHandle()) return { aborted: true };
		if (!active?.success || !Array.isArray(active.data)) return { failed: true };
		const effective = withStatuses(active.data);
		// A fresh backend printing status must never be downgraded by a queued override.
		const jobs = effective.map((job, i) => active.data[i]?.status === "printing" ? active.data[i] : job);
		const historyOk = archived?.success && Array.isArray(archived.data);
		const byId = new Map();
		for (const job of [...jobs, ...(historyOk ? archived.data : [])]) if (owned(job, shopId, customer.number)) byId.set(job._id, job);
		return {
			jobs: [...byId.values()].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || b._id.localeCompare(a._id)),
			partial: history && !historyOk,
		};
	}

	async function show(shopId, customer, mode, language, page, canHandle) {
		const t = T[language];
		const loaded = await loadJobs(shopId, customer, mode === "list", canHandle);
		if (loaded.aborted) return { reply: null };
		if (loaded.failed) return { reply: t.loadFailed };
		const jobs = mode === "cancel" ? loaded.jobs.filter((job) => CANCELLABLE.has(job.status)) : loaded.jobs;
		if (!jobs.length) {
			clear(shopId, customer.number);
			return { reply: [loaded.partial && t.historyFailed, mode === "cancel" ? t.noCancellable : t.noJobs].filter(Boolean).join("\n") };
		}
		const pages = Math.ceil(jobs.length / PAGE_SIZE);
		page = Math.max(0, Math.min(page, pages - 1));
		const rows = jobs.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
		// Save just this page's stable ids; never use a refetched row number to cancel.
		if (!store.set(STORE_KEY, { ...selections(), [keyOf(shopId, customer.number)]: { mode, language, page, ids: rows.map((job) => job._id), at: Date.now() } })) return { reply: t.loadFailed };
		return { selection: true, reply: [
			`*${mode === "cancel" ? t.cancelJobs : t.jobs}*`, loaded.partial && t.historyFailed,
			...rows.map((job, i) => `${i + 1}. ${label(job) || t.job} — ${statusText(job, t)}\n${t.documents}: ${documentNames(job, t)}\n${t.submittedAt}: ${submittedAt(job, language, t)}`),
			pages > 1 && t.page(page + 1, pages), mode === "cancel" ? t.select : t.listHint,
			page + 1 < pages && t.next, page > 0 && t.previous,
		].filter(Boolean).join("\n\n") };
	}

	async function cancel(shopId, customer, reference, language, canHandle) {
		const t = T[language];
		if (reference.invalid) return { reply: t.invalid };
		const loaded = await loadJobs(shopId, customer, true, canHandle);
		if (loaded.aborted) return { reply: null };
		if (loaded.failed) return { reply: t.loadFailed };
		const matches = loaded.jobs.filter((job) => reference.id ? job._id.toLowerCase() === reference.id : String(job.code).padStart(4, "0") === reference.code);
		if (!matches.length) return { reply: loaded.partial ? t.loadFailed : t.notFound };
		if (matches.length > 1) return { reply: t.ambiguous };
		const job = matches[0];
		if (!CANCELLABLE.has(job.status)) { clear(shopId, customer.number); return { reply: closed(job, t) }; }
		if (!await canHandle()) return { reply: null };
		// The engine holds its waiting tasks and checks any in-flight printing PATCH.
		const result = await cancelJob(job);
		if (!await canHandle()) return { reply: null };
		if (result?.success) { clear(shopId, customer.number); return { reply: t.cancelled(label(job)) }; }
		if (result?.reason === "already-printing") { clear(shopId, customer.number); return { reply: t.printing }; }
		// A job can change state between the menu, ownership check and PATCH.
		const latest = await loadJobs(shopId, customer, true, canHandle);
		if (latest.aborted) return { reply: null };
		const updated = latest.jobs?.find((item) => item._id === job._id);
		if (updated && !CANCELLABLE.has(updated.status)) { clear(shopId, customer.number); return { reply: closed(updated, t) }; }
		return { reply: t.cancelFailed };
	}

	async function handleText(shopId, customer, text, { hasDraft = false, canHandle = async () => true } = {}) {
		const word = fold(text);
		const saved = selections()[keyOf(shopId, customer.number)];
		const selection = saved && Number.isFinite(saved.at) && Date.now() - saved.at < SELECTION_MS ? saved : null;
		const command = commandOf(word, hasDraft);
		const navigation = /^(next|more|agla|mazeed|اگلا|مزید)[.!\s]*$/.test(word) ? 1 : /^(previous|prev|pichla|پچھلا)[.!\s]*$/.test(word) ? -1 : 0;
		const exit = /^(back|no|nope|cancel|nahi|nahin|wapas|واپس|نہیں|رہنے دیں)[.!\s]*$/.test(word);
		const serialAnswer = /^(?:cancel\s+)?(?:(?:s\.?\s*no\.?|select|number|نمبر)\s*)?(\d+)[.!\s]*$/.exec(word);
		const answer = !!serialAnswer || /^#\s*\d{1,4}[.!\s]*$/.test(word) || /^[0-9a-f]{24}$/.test(word);
		if (!command && !selection) return null;
		const language = languageOf(text, selection?.language || "en");
		const t = T[language];
		if (customer.numberIsPhone === false || !/^923\d{9}$/.test(customer.number)) return { reply: t.numberUnknown };
		if (!await canHandle()) return { reply: null };
		if (selection && exit) { clear(shopId, customer.number); return { reply: t.back }; }
		if (command?.action === "keep") { clear(shopId, customer.number); return { reply: t.keep }; }
		if (command?.action === "rules") return { reply: t.rules };
		if (command?.action === "list") return show(shopId, customer, "list", languageOf(text), 0, canHandle);
		if (command?.action === "cancel") {
			if (command.reference) return cancel(shopId, customer, command.reference, language, canHandle);
			return show(shopId, customer, "cancel", language, 0, canHandle);
		}
		if (selection && navigation) return show(shopId, customer, selection.mode, language, selection.page + navigation, canHandle);
		if (selection?.mode === "cancel" && answer) {
			const reference = serialAnswer ? (selection.ids[Number(serialAnswer[1]) - 1] ? { id: selection.ids[Number(serialAnswer[1]) - 1] } : { invalid: true }) : referenceOf(word);
			return cancel(shopId, customer, reference || { invalid: true }, language, canHandle);
		}
		if (selection?.mode === "cancel" && CANCEL.test(word) && !DOCUMENT.test(word)) return { reply: t.invalid };
		if (selection && (/^(yes|confirm|ok|okay|haan|ہاں|جی)[.!\s]*$/.test(word) || answer)) return { reply: selection.mode === "cancel" ? t.invalid : t.listHint };
		// A new print instruction leaves job selection, without changing the draft.
		clear(shopId, customer.number);
		return null;
	}

	return { handleText, clear, expireSelections };
}

module.exports = { createWhatsAppJobs };
