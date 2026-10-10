const { detectLanguage } = require("./whatsappChatFlow");
const { removalOf, removalCommandOf } = require("./whatsappChatCommands");

const STORE_KEY = "whatsappJobSelections";
const SELECTION_MS = 10 * 60 * 1000;
const PAGE_SIZE = 6;
const SELECTION_VERSION = 2;
const CANCELLABLE = new Set(["submitted", "queued"]);
const CURRENT = new Set(["submitted", "queued", "printing"]);
const JOB = /\bjobs?\b|جاب|جوب/;
const ORDER = /\borders?\b|آرڈر|ارڈر/;
const WORK = /\b(jobs?|orders?|prints?)\b|جاب|جوب|آرڈر|ارڈر|پرنٹ/;
const LIST = /\b(list|show|display|view|see|tell|check|status|statuses|track|tracking|dikhao|dikha|dikhado|dikhayen|dekhao|batao|bata|batado|bta|btao|btado|batain|bataen|batayein|dikhaen)\b|دکھا|دکھاؤ|دکھائیں|بتا|فہرست|حالت|اسٹیٹس/;
const DOCUMENT = /\b(files?|documents?|pages?|copies|pdfs?|attachments?)\b|فائل|دستاویز|صفح|کاپی/;

function fold(text) {
	return String(text).normalize("NFKC").toLowerCase()
		.replace(/[۰-۹٠-٩]/g, (digit) => String(digit.charCodeAt(0) - (digit >= "۰" ? 0x6f0 : 0x660)))
		.replace(/[\u064b-\u065f\u0670]/g, "")
		.replace(/[\uFE0F\u20E3]/g, "")
		.replace(/[‘’']/g, "").trim();
}

function languageOf(text, fallback = "en") {
	return detectLanguage(text) || (/\b(mera|meri|mere|meray|mery|kro|krdo|kardein|karden|karna|krna|dikhao|dikha|dikhayen|dekhao|batao|btao|batain|bataen|mansookh|mansukh|hatao|hata|hatado|nikalo|nikaalo|nikaal|nikal|nikaldo|doosri|doosra|dusri|dusra|aakhri|akhri|aakhir|akhir|agla|pichla|mazeed)\b/i.test(text) ? "roman_urdu" : fallback);
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
function commandOf(word, hasDraft, selectingJobs = false, allowBareCodes = false) {
	const candidate = referenceOf(word);
	const bareCode = allowBareCodes && !DOCUMENT.test(word) &&
		(/(?:^|\s)\d{4}(?=$|[\s.!?؟])/.test(word) || /^(?:please )?cancel\s+\d{1,4}(?: please)?[.!?؟\s]*$/.test(word));
	// Digits in filenames and ordinal references are not short job IDs.
	const reference = candidate && (candidate.id || bareCode || /#|\b(id|code)\b|آئی ڈی|کوڈ|\b(?:jobs?|orders?)\s+(?:no\.?\s*)?\d+\b|(?:جاب|آرڈر)\s*\d+/.test(word)) ? candidate : null;
	const explicitReference = reference?.id || (reference && (bareCode || /#|\b(id|code)\b|آئی ڈی|کوڈ/.test(word)));
	const bareCancel = /^(?:please |pls |plz )?(?:cancel|mansookh|mansukh|منسوخ|کینسل)(?:\s+(?:kar do|kar dein|karo|kardo|krdo|kro|کر دو|کریں|کردیں))?[.!\s]*$/.test(word);
	const removal = removalCommandOf(word);
	if (removal && (WORK.test(word) || explicitReference || selectingJobs || !hasDraft)) {
		// Draft document edits keep their existing path unless a jobs list is open
		// or the customer explicitly identifies a submitted job.
		if (hasDraft && !selectingJobs && DOCUMENT.test(word) && !JOB.test(word)) return null;
		if (hasDraft && !selectingJobs && !WORK.test(word) && !explicitReference && !bareCancel) return null;
		if (removal === "keep") return { action: "keep" };
		if (removal === "rules") return { action: "rules" };
		// Without a job reference, "cancel my order" still closes an open draft.
		if (hasDraft && !selectingJobs && ORDER.test(word) && !JOB.test(word) && !reference) return null;
		return { action: "cancel", reference };
	}
	if (WORK.test(word) && (LIST.test(word) || /^(?:(my|mere|meri|meray|میرے|میری)\s+)?(jobs|orders|جابز|آرڈرز)[.!?؟\s]*$/.test(word))) return { action: "list" };
	return null;
}

const T = {
	en: {
		cancelQuestion: (job) => `Cancel ${job ? "job " + job : "this job"}?`,
		confirmHint: "Reply *yes* to cancel or *no* to keep it.",
		waitingJobs: "Submitted / queued", printingWarning: "(Can't cancel: already dispatched to printer)",
		chooseJob: "I couldn't identify one job. Choose by S.No., document name or #job ID.",
		currentJobs: "Your current jobs", noCurrentJobs: "You have no current WhatsApp jobs at this shop.",
		menuHint: "Press *0* to go back to the main menu.", cancelOption: "7️⃣ Cancel a job",
		numberedSelect: "Reply with S.No. or #job ID to cancel. Press *0* to go back to the main menu.",
		cancelJobs: "Which job should I cancel?", job: "Job", documents: "Documents", submittedAt: "Submitted at", unavailable: "Unavailable", unnamedDocument: (n) => `Document ${n} (name unavailable)`, page: (p, n) => `Page ${p}/${n}`,
		statuses: { submitted: "Submitted", queued: "Queued", printing: "Printing", completed: "Completed", cancelled: "Cancelled", failed: "Failed" },
		noCancellable: "You have no submitted or queued jobs to cancel.",
		rules: "Only submitted or queued jobs can be cancelled. Jobs that have started printing cannot be cancelled.",
		select: "Choose by S.No., document name or job ID (e.g. *0061*). Reply *back* to exit.",
		listHint: "To cancel a submitted/queued job, send its ID (e.g. *0061*) or *remove <document name / S.No.>*. I'll ask you to confirm.",
		next: "Reply *next* for more.", previous: "Reply *previous* to go back.",
		invalid: "Please choose one job using its S.No. or #job ID.",
		ambiguous: "That job ID matches multiple orders. Reply *cancel my job* and choose a S.No.",
		notFound: "I couldn't find that job among your WhatsApp orders at this shop.",
		printing: "That job has started printing and cannot be cancelled.",
		closed: (status) => `That job is ${status.toLowerCase()} and cannot be cancelled.`,
		cancelled: (label) => label ? `Job ${label} cancelled.` : "Your job was cancelled.", keep: "No job was cancelled.", back: "Job selection closed.",
		loadFailed: "I couldn't load your jobs. Please try again.",
		cancelFailed: "I couldn't cancel that job. Please try again.",
		numberUnknown: "I couldn't verify your WhatsApp number. Please contact the shop.",
	},
	roman_urdu: {
		cancelQuestion: (job) => `${job ? "Job " + job : "Yeh job"} cancel karni hai?`,
		confirmHint: "Cancel karne ke liye *yes*, rehne dene ke liye *no* likhen.",
		waitingJobs: "Submitted / queued", printingWarning: "(Cancel nahi ho sakti: printer ko bhej di gayi hai)",
		chooseJob: "Ek job pehchan nahi saka. S.No., document ka naam ya #job ID bhejen.",
		currentJobs: "Aap ki current jobs", noCurrentJobs: "Is shop par aap ki koi current WhatsApp job nahi hai.",
		menuHint: "Main menu mein wapas jane ke liye *0* bhejen.", cancelOption: "7️⃣ Job cancel karen",
		numberedSelect: "Cancel karne ke liye S.No. ya #job ID bhejen. Main menu mein wapas jane ke liye *0* bhejen.",
		cancelJobs: "Kaunsi job cancel karni hai?", job: "Job", documents: "Documents", submittedAt: "Submit hui", unavailable: "Dastiyab nahi", unnamedDocument: (n) => `Document ${n} (naam dastiyab nahi)`, page: (p, n) => `Page ${p}/${n}`,
		statuses: { submitted: "Submit ho gayi", queued: "Queue mein", printing: "Print ho rahi hai", completed: "Mukammal", cancelled: "Cancel ho gayi", failed: "Fail ho gayi" },
		noCancellable: "Cancel karne ke liye koi submitted ya queued job nahi hai.",
		rules: "Sirf submitted ya queued jobs cancel ho sakti hain. Printing shuru ho chuki ho to job cancel nahi ho sakti.",
		select: "S.No., document ka naam ya job ID (misal: *0061*) bhejen. Wapas jane ke liye *back* likhen.",
		listHint: "Submitted/queued job cancel karne ke liye ID (misal: *0061*) ya *remove <document ka naam / S.No.>* bhejen. Pehle tasdeeq poochunga.",
		next: "Mazeed ke liye *next* likhen.", previous: "Pichle page ke liye *previous* likhen.",
		invalid: "Ek job ka S.No. ya #job ID bhejen.",
		ambiguous: "Is job ID se ek se zyada orders hain. *cancel my job* likhen aur S.No. chunen.",
		notFound: "Is shop par aap ki WhatsApp jobs mein yeh job nahi mili.",
		printing: "Is job ki printing shuru ho chuki hai, ab cancel nahi ho sakti.",
		closed: (status) => `Yeh job ${status} hai, cancel nahi ho sakti.`,
		cancelled: (label) => label ? `Job ${label} cancel ho gayi.` : "Aap ki job cancel ho gayi.", keep: "Koi job cancel nahi ki.", back: "Job selection band kar di.",
		loadFailed: "Jobs load nahi ho sakin. Dobara koshish karen.",
		cancelFailed: "Job cancel nahi ho saki. Dobara koshish karen.",
		numberUnknown: "Aap ka WhatsApp number verify nahi ho saka. Shop se rabta karen.",
	},
	urdu: {
		cancelQuestion: (job) => `${job ? "جاب " + job : "یہ جاب"} منسوخ کرنی ہے؟`,
		confirmHint: "منسوخ کرنے کے لیے *yes*، برقرار رکھنے کے لیے *no* لکھیں۔",
		waitingJobs: "جمع شدہ / قطار میں", printingWarning: "(منسوخ نہیں ہو سکتی: پرنٹر کو بھیج دی گئی ہے)",
		chooseJob: "ایک جاب کی شناخت نہیں ہو سکی۔ فہرست کا نمبر، دستاویز کا نام یا #جاب آئی ڈی بھیجیں۔",
		currentJobs: "آپ کی موجودہ جابز", noCurrentJobs: "اس دکان پر آپ کی کوئی موجودہ واٹس ایپ جاب نہیں ہے۔",
		menuHint: "مرکزی مینو میں واپس جانے کے لیے *0* بھیجیں۔", cancelOption: "7️⃣ جاب منسوخ کریں",
		numberedSelect: "منسوخ کرنے کے لیے فہرست کا نمبر یا #جاب آئی ڈی بھیجیں۔ مرکزی مینو میں واپس جانے کے لیے *0* بھیجیں۔",
		cancelJobs: "کون سی جاب منسوخ کرنی ہے؟", job: "جاب", documents: "دستاویزات", submittedAt: "جمع ہوئی", unavailable: "دستیاب نہیں", unnamedDocument: (n) => `دستاویز ${n} (نام دستیاب نہیں)`, page: (p, n) => `صفحہ ${p}/${n}`,
		statuses: { submitted: "جمع ہو گئی", queued: "قطار میں", printing: "پرنٹنگ جاری ہے", completed: "مکمل", cancelled: "منسوخ", failed: "ناکام" },
		noCancellable: "منسوخ کرنے کے لیے کوئی جمع شدہ یا قطار میں موجود جاب نہیں ہے۔",
		rules: "صرف جمع شدہ یا قطار میں موجود جاب منسوخ ہو سکتی ہے۔ پرنٹنگ شروع ہو چکی ہو تو جاب منسوخ نہیں ہو سکتی۔",
		select: "فہرست کا نمبر، دستاویز کا نام یا جاب آئی ڈی (مثلاً *0061*) بھیجیں۔ واپس جانے کے لیے *back* لکھیں۔",
		listHint: "جمع شدہ یا قطار میں موجود جاب منسوخ کرنے کے لیے آئی ڈی (مثلاً *0061*) یا *remove <دستاویز کا نام / فہرست نمبر>* بھیجیں۔ پہلے تصدیق پوچھوں گا۔",
		next: "مزید کے لیے *next* لکھیں۔", previous: "پچھلے صفحے کے لیے *previous* لکھیں۔",
		invalid: "ایک جاب کا فہرست نمبر یا #جاب آئی ڈی بھیجیں۔",
		ambiguous: "اس جاب آئی ڈی سے ایک سے زیادہ آرڈرز ہیں۔ *cancel my job* لکھیں اور فہرست سے نمبر منتخب کریں۔",
		notFound: "اس دکان پر آپ کی واٹس ایپ جابز میں یہ جاب نہیں ملی۔",
		printing: "اس جاب کی پرنٹنگ شروع ہو چکی ہے، اب منسوخ نہیں ہو سکتی۔",
		closed: (status) => `یہ جاب ${status} ہے، منسوخ نہیں ہو سکتی۔`,
		cancelled: (label) => label ? `جاب ${label} منسوخ کر دی۔` : "آپ کی جاب منسوخ کر دی۔", keep: "کوئی جاب منسوخ نہیں کی۔", back: "جاب کا انتخاب بند کر دیا۔",
		loadFailed: "جابز حاصل نہیں ہو سکیں۔ دوبارہ کوشش کریں۔",
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
			if (selection?.version !== SELECTION_VERSION || !Number.isFinite(selection?.at) || Date.now() - selection.at >= SELECTION_MS) { delete saved[key]; changed = true; }
		}
		if (changed) store.set(STORE_KEY, saved);
	}
	function owned(job, shopId, number) {
		const shop = typeof job?.shop === "string" ? job.shop : job?.shop?._id;
		return job?.source === "shop" && job.channel === "whatsapp" && shop === shopId &&
			job.customer?.number === number && typeof job._id === "string" && /^[0-9a-f]{24}$/i.test(job._id);
	}
	function label(job) { return job.code ? `*#${job.code}*` : null; }
	function documentNameList(job) {
		const seen = new Set();
		const names = [];
		for (const entry of (job.files || [])) {
			const fileId = typeof entry.file === "string" ? entry.file : entry.file?._id || entry.fileId;
			// One file can have several entries for different page settings.
			if (fileId && seen.has(fileId)) continue;
			if (fileId) seen.add(fileId);
			const name = String(entry.file?.name || entry.name || entry.fileName || "").replace(/[\r\n`]/g, " ").trim();
			names.push(name);
		}
		return names;
	}
	function documentNames(job, t) {
		const names = documentNameList(job);
		return names.length ? names.map((name, i) => name ? `\`${name}\`` : t.unnamedDocument(i + 1)).join(", ") : t.unavailable;
	}
	function targetOf(job) {
		return { id: job._id, names: documentNameList(job).filter(Boolean) };
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
		// Terminal backend states stay terminal. A queued override cannot make a
		// printing job cancellable, while locally completed jobs stay hidden.
		const jobs = effective.map((job, i) => {
			const raw = active.data[i];
			return raw && (!CURRENT.has(raw.status) || (raw.status === "printing" && CANCELLABLE.has(job.status))) ? raw : job;
		});
		const historyOk = archived?.success && Array.isArray(archived.data);
		const byId = new Map();
		for (const job of [...(historyOk ? archived.data : []), ...jobs]) if (owned(job, shopId, customer.number)) byId.set(job._id, job);
		return {
			jobs: [...byId.values()].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || b._id.localeCompare(a._id)),
			partial: history && !historyOk,
		};
	}

	async function menuAvailability(shopId, customer, canHandle = async () => true) {
		if (customer.numberIsPhone === false || !/^923\d{9}$/.test(customer.number)) return { hasJobs: false, canCancel: false };
		const loaded = await loadJobs(shopId, customer, false, canHandle);
		if (loaded.aborted || loaded.failed) return loaded;
		return {
			hasJobs: loaded.jobs.some((job) => CURRENT.has(job.status)),
			canCancel: loaded.jobs.some((job) => CANCELLABLE.has(job.status)),
		};
	}

	async function show(shopId, customer, mode, language, page, canHandle, numbered = false) {
		const t = T[language];
		const loaded = await loadJobs(shopId, customer, false, canHandle);
		if (loaded.aborted) return { reply: null };
		if (loaded.failed) return { reply: t.loadFailed };
		const jobs = loaded.jobs.filter((job) => (mode === "cancel" ? CANCELLABLE : CURRENT).has(job.status));
		if (!jobs.length) {
			clear(shopId, customer.number);
			return { reply: [mode === "cancel" ? t.noCancellable : t.noCurrentJobs, numbered && t.menuHint].filter(Boolean).join("\n") };
		}
		const canCancel = jobs.some((job) => CANCELLABLE.has(job.status));
		const pages = Math.ceil(jobs.length / PAGE_SIZE);
		page = Math.max(0, Math.min(page, pages - 1));
		const rows = jobs.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
		const waiting = rows.filter((job) => CANCELLABLE.has(job.status));
		const printing = rows.filter((job) => job.status === "printing");
		// Save just this page's stable ids; never use a refetched row number to cancel.
		if (!store.set(STORE_KEY, { ...selections(), [keyOf(shopId, customer.number)]: {
			version: SELECTION_VERSION, mode, language, page, numbered, canCancel,
			ids: waiting.map((job) => job._id), targets: waiting.map(targetOf), printing: printing.map(targetOf), at: Date.now(),
		} })) return { reply: t.loadFailed };
		const describe = (job, i) => `${i + 1}. ${label(job) || t.job} — ${statusText(job, t)}\n${t.documents}: ${documentNames(job, t)}\n${t.submittedAt}: ${submittedAt(job, language, t)}`;
		return { selection: true, reply: [
			`*${mode === "cancel" ? t.cancelJobs : t.currentJobs}*`,
			waiting.length > 0 && mode !== "cancel" && `*${t.waitingJobs}*`,
			...waiting.map(describe),
			printing.length > 0 && `*${t.printingWarning}*`,
			...printing.map(describe),
			pages > 1 && t.page(page + 1, pages),
			mode === "cancel" ? (numbered ? t.numberedSelect : t.select) : mode === "current" ? [canCancel && t.cancelOption, t.menuHint].filter(Boolean).join("\n") : canCancel && t.listHint,
			page + 1 < pages && t.next, page > 0 && t.previous,
		].filter(Boolean).join("\n\n") };
	}

	async function cancel(shopId, customer, reference, language, canHandle, confirmFirst = false) {
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
		if (confirmFirst) {
			// Persist only the reviewed job's stable ID. The confirming reply will
			// re-fetch ownership/status before the engine receives a cancellation.
			if (!store.set(STORE_KEY, { ...selections(), [keyOf(shopId, customer.number)]: {
				version: SELECTION_VERSION, mode: "confirmCancel", language, numbered: false,
				ids: [job._id], targets: [targetOf(job)], printing: [], at: Date.now(),
			} })) return { reply: t.loadFailed };
			return { selection: true, reply: [
				t.cancelQuestion(label(job)),
				`${t.documents}: ${documentNames(job, t)}`,
				`${t.submittedAt}: ${submittedAt(job, language, t)}`,
				t.confirmHint,
			].join("\n\n") };
		}
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

	// Resolve filenames and positions through the same selector as draft removal.
	// Displayed positions refer only to the submitted/queued section; printing
	// names remain recognisable so an explicit request gets the correct refusal.
	async function cancelFromText(shopId, customer, text, selection, language, canHandle, confirmFirst = false) {
		const t = T[language];
		const choose = async () => {
			const choices = await show(shopId, customer, "cancel", language, selection?.mode === "cancel" ? selection.page : 0, canHandle, !!selection?.numbered);
			return choices.reply ? { ...choices, reply: `${t.chooseJob}\n\n${choices.reply}` } : choices;
		};
		let waiting = selection?.targets, printing = selection?.printing;
		if (!waiting || !printing) {
			const loaded = await loadJobs(shopId, customer, false, canHandle);
			if (loaded.aborted) return { reply: null };
			if (loaded.failed) return { reply: t.loadFailed };
			waiting = loaded.jobs.filter((job) => CANCELLABLE.has(job.status)).map(targetOf);
			printing = loaded.jobs.filter((job) => job.status === "printing").map(targetOf);
		}
		const context = (targets) => ({ files: targets.map((target) => ({ file: target.id, names: target.names })) });
		const all = [...waiting, ...printing];
		let targets = all;
		let removal = removalOf(text, context(all), true);
		if (!removal) { clear(shopId, customer.number); return null; } // a page/settings edit belongs to the draft flow
		if (removal.keep) return { reply: t.keep };
		if (removal.by === "focus") return choose(); // "this" has no unique job reference
		if (!selection && removal.by !== "name") return choose(); // positions need a displayed list
		if (removal.by !== "name") {
			const printingReference = /\bprinting\b|\bprint ho rahi\b|پرنٹنگ|پرنٹ ہو رہی/.test(fold(text));
			targets = printingReference ? printing : waiting;
			if (!targets.length) return { reply: t.noCancellable };
			removal = removalOf(text, context(targets), true);
		}
		if (!removal?.clarify && removal?.indices?.length === 1 && removal.by !== "all") {
			const target = targets[removal.indices[0]];
			if (target) return cancel(shopId, customer, { id: target.id }, language, canHandle, confirmFirst);
		}
		// Unknown/duplicate filenames and multiple targets require a new choice.
		// Never guess or send several cancellation requests from one message.
		return choose();
	}

	async function handleText(shopId, customer, text, { hasDraft = false, menuAction = null, numberedMenu = false, canHandle = async () => true } = {}) {
		const word = fold(text);
		const saved = selections()[keyOf(shopId, customer.number)];
		let selection = saved?.version === SELECTION_VERSION && Number.isFinite(saved.at) && Date.now() - saved.at < SELECTION_MS ? saved : null;
		if (selection && !!selection.numbered !== numberedMenu) { clear(shopId, customer.number); selection = null; }
		const aiChat = !numberedMenu;
		const command = commandOf(word, hasDraft, !!selection, aiChat) || (!selection && menuAction ? { action: menuAction } : null);
		const navigation = /^(next|more|agla|mazeed|اگلا|مزید)[.!\s]*$/.test(word) ? 1 : /^(previous|prev|pichla|پچھلا)[.!\s]*$/.test(word) ? -1 : 0;
		const exit = /^(back|no|nope|cancel|nahi|nahin|wapas|واپس|نہیں|رہنے دیں)[.!\s]*$/.test(word);
		const serialAnswer = /^(?:(?:cancel|remove|delete|drop|hatao|nikalo)\s+)?(?:(?:s\.?\s*no\.?|select|number|نمبر)\s*)?(\d+)[.!\s]*$/.exec(word);
		const answer = !!serialAnswer || /^#\s*\d{1,4}[.!\s]*$/.test(word) || /^[0-9a-f]{24}$/.test(word);
		const codeAnswer = /^(\d{1,4})[.!?؟\s]*$/.exec(word);
		const bareCode = aiChat && codeAnswer && (codeAnswer[1].length === 4 || codeAnswer[1].startsWith("0") ||
			selection?.mode === "list" || (!selection && !hasDraft) || (selection?.mode === "cancel" && !selection.ids[Number(codeAnswer[1]) - 1]));
		if (!command && !selection && !bareCode) return null;
		const language = languageOf(text, selection?.language || "en");
		const t = T[language];
		if (customer.numberIsPhone === false || !/^923\d{9}$/.test(customer.number)) return { reply: t.numberUnknown };
		if (!await canHandle()) return { reply: null };
		if (aiChat && selection?.mode === "confirmCancel") {
			if (/^(no|n|nope|back|cancel|keep|keep it|nahi|nahin|wapas|نہیں|رہنے دیں)[.!\s]*$/.test(word) || command?.action === "keep") {
				clear(shopId, customer.number);
				return { reply: t.keep };
			}
			if (/^(yes|y|confirm|ok|okay|haan|han|ji|jee|ہاں|جی|تصدیق)[.!\s]*$/.test(word)) {
				return cancel(shopId, customer, { id: selection.ids[0] }, language, canHandle);
			}
			if (!bareCode && command?.action !== "cancel" && command?.action !== "list") return { reply: command?.action === "rules" ? `${t.rules}\n\n${t.confirmHint}` : t.confirmHint };
			clear(shopId, customer.number);
			selection = null;
		}
		if (bareCode) return cancel(shopId, customer, { code: codeAnswer[1].padStart(4, "0") }, language, canHandle, true);
		if (hasDraft && /\b(?:from|in)\s+(?:(?:the|my)\s+)?draft\b(?!\.)|\bdraft\s+(?:se|mein)\b|مسودے سے/.test(word) && !JOB.test(word)) { clear(shopId, customer.number); return null; }
		if (selection && word === "menu") { clear(shopId, customer.number); return null; }
		if (selection && (selection.numbered || numberedMenu) && word === "0") { clear(shopId, customer.number); return null; }
		if (selection?.mode === "current" && selection.canCancel && word === String(PAGE_SIZE + 1)) return show(shopId, customer, "cancel", language, 0, canHandle, true);
		if (selection && exit) { clear(shopId, customer.number); return { reply: t.back }; }
		if (command?.action === "keep") { clear(shopId, customer.number); return { reply: t.keep }; }
		if (command?.action === "rules") return { reply: t.rules };
		if (command?.action === "list") return show(shopId, customer, menuAction === "list" ? "current" : "list", languageOf(text), 0, canHandle, !!menuAction);
		if (selection && answer && (selection.mode === "cancel" || command?.action === "cancel") && !command?.reference) {
			const reference = serialAnswer ? (selection.ids[Number(serialAnswer[1]) - 1] ? { id: selection.ids[Number(serialAnswer[1]) - 1] } : { invalid: true }) : referenceOf(word);
			return cancel(shopId, customer, reference || { invalid: true }, language, canHandle, aiChat);
		}
		if (command?.action === "cancel") {
			if (command.reference) return cancel(shopId, customer, command.reference, language, canHandle, aiChat);
			if (menuAction || /^(?:please |pls |plz )?(?:cancel|mansookh|mansukh|منسوخ|کینسل)(?:\s+(?:my|mera|meri|میری|میرا))?(?:\s+(?:job|order|جاب|آرڈر))?[.!\s]*$/.test(word)) return show(shopId, customer, "cancel", language, 0, canHandle, !!menuAction);
			return cancelFromText(shopId, customer, text, selection, language, canHandle, aiChat);
		}
		if (selection && navigation) return show(shopId, customer, selection.mode, language, selection.page + navigation, canHandle, selection.numbered);
		if (selection?.mode === "cancel" && !/^(yes|confirm|ok|okay|haan|ہاں|جی)[.!\s]*$/.test(word)) return cancelFromText(shopId, customer, text, selection, language, canHandle, aiChat);
		if (selection && (/^(yes|confirm|ok|okay|haan|ہاں|جی)[.!\s]*$/.test(word) || answer)) return { reply: selection.mode === "cancel" ? t.invalid : selection.mode === "current" ? [selection.canCancel && t.cancelOption, t.menuHint].filter(Boolean).join("\n") : t.listHint };
		// A new print instruction leaves job selection, without changing the draft.
		clear(shopId, customer.number);
		return null;
	}

	return { handleText, clear, expireSelections, menuAvailability };
}

module.exports = { createWhatsAppJobs };
