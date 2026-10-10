const { detectLanguage } = require("./whatsappChatFlow");

const T = {
	en: {
		hint: "To read instructions, type *instructions*.",
		instructions: [
			"*ClickPrint instructions*",
			"• To print: tap 📎 *Attach → Document*, choose your file and send it.",
			"• Send your print settings: paper size, B&W/colour, sides and copies.",
			"• Review the total, reply *confirm*, then choose a payment option.",
			"• Remove a draft file: *remove notes.pdf* or *remove file 2*.",
			"• View active jobs: *list my jobs*.",
			"• Cancel a job: *cancel 0061*, then reply *yes* when asked to confirm.",
		].join("\n"),
	},
	roman_urdu: {
		hint: "Instructions parhne ke liye *instructions* likhen.",
		instructions: [
			"*ClickPrint instructions*",
			"• Print ke liye 📎 *Attach → Document* chunen, file select karke bhejen.",
			"• Print settings batayen: paper size, B&W/colour, sides aur copies.",
			"• Total dekh kar *confirm* likhen, phir payment option chunen.",
			"• Draft ki file hatayen: *remove notes.pdf* ya *remove file 2*.",
			"• Current jobs dekhen: *list my jobs*.",
			"• Job cancel karen: *cancel 0061*, phir tasdeeq ke liye *yes* likhen.",
		].join("\n"),
	},
	urdu: {
		hint: "ہدایات پڑھنے کے لیے *instructions* لکھیں۔",
		instructions: [
			"*ClickPrint ہدایات*",
			"• پرنٹ کے لیے 📎 *Attach → Document* منتخب کریں، فائل چن کر بھیجیں۔",
			"• پرنٹ سیٹنگز بتائیں: کاغذ کا سائز، رنگین/سیاہ سفید، سائیڈز اور کاپیاں۔",
			"• کل رقم دیکھ کر *confirm* لکھیں، پھر ادائیگی کا آپشن منتخب کریں۔",
			"• ڈرافٹ کی فائل ہٹائیں: *remove notes.pdf* یا *remove file 2*۔",
			"• موجودہ جابز دیکھیں: *list my jobs*۔",
			"• جاب منسوخ کریں: *cancel 0061*، پھر تصدیق کے لیے *yes* لکھیں۔",
		].join("\n"),
	},
};

function createChatHelp(core, welcome) {
	async function receive(shopId, customer, { kind, messageId, text = "" }, send) {
		const key = core.keyOf(shopId, customer.number);
		core.expire(key);
		const start = core.beginChatSession(key, kind, messageId);
		const language = detectLanguage(text) || core.getEntry(key)?.language || "en";
		const t = T[language] || T.en;
		if (!start.introSent) {
			const greeting = start.kind === "text" && start.messageId === messageId
				? await welcome.message(shopId, customer, text, "AI") : null;
			if (!await send([greeting, t.hint].filter(Boolean).join("\n\n"))) return { stop: true };
			core.markChatIntroSent(key);
			if (greeting) welcome.sent(shopId, customer, "AI");
		}
		const command = String(text).normalize("NFKC").trim().replace(/^\*|\*$/g, "");
		if (kind === "text" && /^(instructions|ہدایات)[.!?؟\s]*$/i.test(command)) {
			await send(t.instructions);
			return { stop: true };
		}
		return { stop: false };
	}
	return { receive };
}

module.exports = { createChatHelp };
