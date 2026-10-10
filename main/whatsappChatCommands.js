// Commands that must not depend on the model's print-settings schema.
function fold(value) {
	return String(value).toLowerCase().normalize("NFKC").replace(/[۰-۹٠-٩]/g, (digit) => String(digit.charCodeAt(0) - (digit >= "۰" ? 0x6f0 : 0x660))).replace(/[\u064b-\u065f\u0670]/g, "").replace(/[“”‘’`"']/g, "").trim();
}

const DOCUMENT = /\b(files?|documents?|pdfs?|attachments?)\b|فائل|دستاویز|پی ڈی ایف/;
const REMOVE = /\b(remove|delete|drop|cancel|cancle|cansel|kensal|mansookh|mansukh|discard|hatao|hata|hatado|nikalo|nikaalo|nikaal|nikal|nikaldo)\b|حذف|ہٹا|نکال|منسوخ|کینسل|\btake\b.*\bout\b/;
const NEGATED = /\b(dont|do not|never|mat|nahi|nahin)\b|نہیں|(?:^|\s)(نہ|مت)(?:\s|$)/;
const QUESTION = /\b(can i|could i|may i|how|if|whether|should|what|which|show|status|kya|kaise|agar)\b|کیا|کیسے|اگر|دکھا|اسٹیٹس|حالت/;
const ORDINALS = [
	/\b(first|1st|pehli|pehla)\b|پہلی|پہلا/,
	/\b(second|2nd|doosri|dusri|doosra|dusra)\b|دوسری|دوسرا/,
	/\b(third|3rd|teesri|teesra)\b|تیسری|تیسرا/,
	/\b(fourth|4th|chauthi|chautha)\b|چوتھی|چوتھا/,
	/\b(fifth|5th|paanchwi|panchwi)\b|پانچویں/,
];
const FILLER = new Set(["the", "this", "that", "please", "pls", "plz", "just", "only", "from", "my", "mera", "meri", "mere", "job", "jobs", "order", "draft", "list", "doc", "kar", "karo", "kardo", "krdo", "karna", "dena", "karden", "kardein", "wali", "wala", "waali", "waala", "iss", "isko", "ko", "se", "دیں", "دو", "کر", "کریں", "کردو", "کردیں", "کرو", "کرنا", "سے", "والی", "والا", "میری", "میرا", "میرے", "جاب", "جوب", "آرڈر"]);

// Share the action/negation checks with submitted-job cancellation. A question
// about removal must never send a destructive request.
function removalCommandOf(text) {
	const word = fold(text);
	if (!REMOVE.test(word)) return null;
	const direct = word.replace(/^(can|could|would) you (please )?/, "");
	if (NEGATED.test(direct)) return "keep";
	if (/\b(can i|could i|may i|how|if|whether|should|kya|kaise|agar)\b|کیا|کیسے|اگر/.test(direct)) return "rules";
	return "remove";
}

function containsName(text, name) {
	for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
		if (!/[\p{L}\p{N}_.-]/u.test(text[at - 1] || "") && !/[\p{L}\p{N}_.-]/u.test(text[at + name.length] || "")) return true;
	}
	return false;
}

// Returns null for settings/ordinary chat, or a safe file selection. An
// unresolved reference asks for clarification instead of guessing a deletion.
function removalOf(text, entry, selecting = false) {
	const word = fold(text);
	if (!word) return null;
	if (selecting && /^(no|nope|nahi|nahin|never mind|nevermind|cancel removal|نہیں|رہنے دیں)[.!\s]*$/.test(word)) return { keep: true };
	if (selecting && /^(yes|ok|okay|confirm|haan|han|جی|ہاں)[.!\s]*$/.test(word)) return { clarify: true };
	const files = entry.files || [];
	// Submitted jobs may have several document names referring to one item.
	const names = files.flatMap((file, i) => (file.names || [file.name || ""]).map((name) => ({ i, name: fold(name) })));
	const namedMatches = names.filter(({ name }) => name && containsName(word, name));
	const named = [...new Set(namedMatches.map(({ i }) => i))];
	const reference = /\b(this|that|it|last|latest|newest|aakhri|akhri|aakhir|akhir)\b|یہ|اس|آخری|آخر|\b\d+(st|nd|rd|th)\b/.test(word) || ORDINALS.some((pattern) => pattern.test(word));
	const request = REMOVE.test(word) && (DOCUMENT.test(word) || named.length || reference || /^(remove|delete|drop|hatao|nikalo)$/.test(word));
	if (!request && !selecting) return null;
	// Removing a page, color setting or copy is not removing its document.
	const instruction = names.reduce((value, { name }) => name ? value.replaceAll(name, "") : value, word);
	if ((request || selecting) && NEGATED.test(instruction)) return { keep: true };
	if ((request || selecting) && QUESTION.test(instruction.replace(/^(can|could|would) you (please )?/, ""))) return { clarify: true };
	if (/\b(or|except|keep|but|ya)\b|کے علاوہ|یا/.test(instruction)) return { clarify: true };
	if (/\b(pages?|color|colour|copies|copy|binding|staples?)\b|صفح|رنگ|کاپی|بائنڈنگ/.test(instruction)) return null;
	if (/\b(all|every|sab|saab|tamam)\s+(files?|documents?|pdfs?|attachments?|jobs?|orders?)\b|تمام فائل|تمام دستاویز|ساری فائل|سب فائل|تمام جاب|سب جاب/.test(word) || (selecting && /^(all|sab|saab|tamam|سب|تمام)$/.test(word))) return { indices: files.map((_, i) => i), by: "all" };
	if (named.length) {
		const ambiguous = namedMatches.some(({ name }) => new Set(namedMatches.filter((match) => match.name === name).map(({ i }) => i)).size > 1);
		return ambiguous ? { clarify: true, by: "name" } : { indices: named, by: "name" };
	}
	const indices = new Set();
	for (let i = 0; i < ORDINALS.length; i++) if (ORDINALS[i].test(word)) indices.add(i);
	for (const match of word.matchAll(/\b(\d+)(?:st|nd|rd|th)\b/g)) indices.add(Number(match[1]) - 1);
	const fromEnd = /\bfrom\s+(?:the\s+)?(?:last|end|bottom)\b|\b(?:last|aakhri|akhri|aakhir|akhir)\s+se\b|(?:آخر|آخری)\s+سے/.test(word);
	if (fromEnd) {
		if (!indices.size) for (const number of word.match(/\b\d+\b/g) || []) indices.add(Number(number) - 1);
		if (indices.size !== 1) return { clarify: true, by: "position" };
		const offset = [...indices][0];
		return offset >= 0 && offset < files.length ? { indices: [files.length - 1 - offset], by: "position" } : { clarify: true, by: "position" };
	}
	if (/\b(last|latest|newest|aakhri|akhri)\b|آخری/.test(word)) indices.add(files.length - 1);
	for (const match of word.matchAll(/(?:\b(?:files?|documents?|pdfs?)\s*(?:numbers?|no\.?|#)?\s*|#|(?:فائل|دستاویز)\s*)(\d+)\b/g)) indices.add(Number(match[1]) - 1);
	if (/\b(files?|documents?|pdfs?)\s*(?:numbers?|no\.?|#)?\s*\d+[\s,]*(?:and|&|,)/.test(word)) {
		for (const number of word.match(/\b\d+\b/g) || []) indices.add(Number(number) - 1);
	}
	if (selecting && /^[\d\s,،&]+$/.test(word)) {
		for (const number of word.match(/\d+/g) || []) indices.add(Number(number) - 1);
	}
	if (indices.size) {
		return [...indices].every((i) => i >= 0 && i < files.length) ? { indices: [...indices], by: "position" } : { clarify: true, by: "position" };
	}
	// Match an unambiguous fragment of a filename, e.g. "remove the invoice document".
	const tokens = word.replace(/\.(pdf|docx?|jpe?g|png)\b/g, "")
		.split(/[^\p{L}\p{N}_-]+/u).filter((token) => token.length >= 3 &&
			!REMOVE.test(token) && !DOCUMENT.test(token) &&
			!FILLER.has(token));
	const partial = tokens.length ? [...new Set(names.filter(({ name }) => tokens.every((token) => name.includes(token))).map(({ i }) => i))] : [];
	if (partial.length === 1) return { indices: partial, by: "name" };
	if (partial.length > 1) return { clarify: true, by: "name" };
	if (/\b(this|that|it|ye|yeh|iss|is|isko)\b|یہ|اس/.test(word)) {
		if (/\b(or|ya)\b|یا/.test(word)) return { clarify: true };
		if (tokens.length) return { clarify: true };
		const focused = files.map((file, i) => (entry.focusedFiles || []).includes(file.file) ? i : -1).filter((i) => i >= 0);
		return focused.length > 1 ? { clarify: true } : { indices: focused.length ? focused : [files.length - 1], by: "focus" };
	}
	return files.length === 1 && !tokens.length ? { indices: [0] } : { clarify: true };
}

function pickupQuestion(text) {
	if (/\b(color|colour|copies|sided|landscape|portrait|pages?|a[34])\b|رنگین|کاپی|صفح/.test(fold(text))) return false;
	return /\b(cash|cop|cod|pickup|pick[ -]?up|collect|collection|counter|deliver\w*|payment|pay|online|transfer|wallet|receive|naqad|nakad)\b|کیش|نقد|ادائیگی|پک اپ|کاؤنٹر|ڈیلیوری|وصول/.test(fold(text));
}

// Questions, negations and conditional statements must never choose payment.
function paymentAnswer(text) {
	return /^(?:(?:i will |ill |i want to |pay |payment by ))?(?:cash(?: on pickup)?|cop|cod|naqad|nakad|online|bank transfer|transfer|bank|jazzcash|easypaisa|sadapay|nayapay|نقد|کیش|آن لائن|آنلائن)(?: please| pls| plz| کر دوں گا| ادا کروں گا)?[.!\s]*$/.test(fold(text));
}

module.exports = { removalOf, removalCommandOf, pickupQuestion, paymentAnswer };
