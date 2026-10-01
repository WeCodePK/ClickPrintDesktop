// The AI chat flow (main/whatsappChatFlow.js on the whatsappOrders.js core):
// files are acknowledged once per batch, settings come from the backend's
// inference endpoint as per-page changes, the total is shown with every change,
// and one "confirm" (or a yes-word after the total) places the order. Runs
// against an in-memory fake of the drafts API and a scripted inference.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createOrderCore } = require("../main/whatsappOrders");
const {
	createChatFlow,
	detectLanguage,
	wholeFile,
	applyChanges,
	toDraftFiles,
	toContextFile,
	describeOrder,
	T,
} = require("../main/whatsappChatFlow");

const customer = { name: "Ali Khan", number: "923001234567" };
const cost = { lines: [{ item: "A4-BW", quantity: 4, rate: 10, subtotal: 40 }], extra: [], total: 48 };

// A change as the backend returns it: everything null unless given.
const change = (fields) => ({
	files: [], pages: "", only: false, color: null, pageType: null, sides: null,
	duplex: null, orientation: null, pagesPerSheet: null, copies: null, ...fields,
});
const inferred = (fields) => ({ success: true, status: 200, data: { intent: "settings", language: "en", changes: [], question: "", ...fields } });

function setup() {
	const backend = new Map();
	const calls = [];
	const inferences = []; // request bodies
	const script = []; // queued inference responses
	let nextId = 1;
	let saved = {};
	const api = {
		failCheck: false,
		async createDraft(body) {
			calls.push(["create", body]);
			const draft = { _id: `d${nextId++}`, ...body };
			backend.set(draft._id, draft);
			return { success: true, status: 201, data: draft };
		},
		async updateDraft(id, body) {
			calls.push(["update", id, body]);
			if (!backend.has(id)) return { success: false, status: 404, message: "draft not found" };
			backend.set(id, { _id: id, ...body });
			return { success: true, status: 200, data: backend.get(id) };
		},
		async checkDraft(id) {
			calls.push(["check", id]);
			if (api.failCheck) return { success: false, status: 400, message: "unable to price job" };
			if (!backend.has(id)) return { success: false, status: 404, message: "draft not found" };
			// Like the backend: one cost line per draft entry, in order (2 sheets each).
			const lines = backend.get(id).files.map(({ settings: s }) => {
				const rate = s.color ? 10 : 4;
				return { item: `${s.pageType} ${s.color ? "Color" : "B&W"}`, quantity: 2, rate, subtotal: 2 * rate };
			});
			return { success: true, status: 200, data: { ...backend.get(id), cost: { lines, extra: [], total: 48 } } };
		},
		async submitDraft(id) {
			calls.push(["submit", id]);
			if (!backend.has(id)) return { success: false, status: 404 };
			backend.delete(id);
			return { success: true, status: 200, data: { _id: "j1", code: "0427", cost } };
		},
		async deleteDraft(id) {
			calls.push(["delete", id]);
			backend.delete(id);
			return { success: true, status: 200 };
		},
		async inferSettings(body) {
			inferences.push(body);
			return script.shift() ?? inferred({ intent: "offtopic" });
		},
		// No COD limit and no wallet by default: confirming places the order directly.
		shop: {},
		async fetchShop() {
			calls.push(["shop"]);
			return api.shop ? { success: true, status: 200, data: api.shop } : { success: false, message: "offline" };
		},
	};
	const core = createOrderCore({ api, load: () => structuredClone(saved), save: (map) => (saved = map) });
	const flow = createChatFlow(core, api);
	const say = (text) => flow.handleText("shop1", customer, text);
	const add = (id, name, pages, opts) => flow.addFile("shop1", customer, { _id: id, numberOfPages: pages }, name, opts);
	const lastFiles = () => calls.filter((c) => c[0] === "update" || c[0] === "create").at(-1).at(-1).files;
	const entry = () => Object.values(saved)[0];
	return { flow, api, backend, calls, inferences, script, say, add, lastFiles, entry };
}

// ── Per-page settings ─────────────────────────────────────────────────────────

const file = (pages) => ({ file: "f1", name: "a.pdf", numberOfPages: pages, runs: wholeFile(pages) });
const draftOf = (files) => toDraftFiles({ files });

test("a new file prints every page with the defaults", () => {
	assert.deepEqual(draftOf([file(12)]), [{
		file: "f1",
		settings: { color: false, pageType: "A4", pagesPerSheet: 1, numberOfCopies: 1, sidedness: "long", orientation: "portrait", pageSelection: "" },
	}]);
});

test("'first page color, the rest black and white, single side' splits the file", () => {
	const files = applyChanges([file(12)], [
		change({ files: [1], color: false, sides: "single" }),
		change({ files: [1], pages: "1", color: true }),
	]);
	const draft = draftOf(files);
	assert.deepEqual(draft.map((f) => [f.settings.pageSelection, f.settings.color, f.settings.sidedness]), [
		["1", true, "none"],
		["2-12", false, "none"],
	]);
	assert.equal(describeOrder({ files }, null, T.en), "• `a.pdf` (single-sided)\n   page 1 color\n   pages 2-12 B&W");
});

test("'only pages 3-7, 2 copies' leaves the other pages out", () => {
	const files = applyChanges([file(12)], [change({ files: [1], pages: "3-7", only: true, copies: 2 })]);
	assert.deepEqual(draftOf(files).map((f) => [f.settings.pageSelection, f.settings.numberOfCopies]), [["3-7", 2]]);
	assert.equal(describeOrder({ files }, null, T.en), "• `a.pdf` (2 copies)\n   only pages 3-7");

	// Naming pages brings them back; "all files color" alone doesn't.
	const colored = applyChanges(files, [change({ color: true })]);
	assert.deepEqual(draftOf(colored).map((f) => f.settings.pageSelection), ["3-7"]);
	// Every page prints again; 3-7 keep their 2 copies.
	const back = applyChanges(files, [change({ files: [1], pages: "", only: true })]);
	assert.deepEqual(draftOf(back).map((f) => [f.settings.pageSelection, f.settings.numberOfCopies]), [["1-2,8-12", 1], ["3-7", 2]]);
});

test("the summary lists each file with only its changed settings and its costs", () => {
	const files = applyChanges(
		[file(12), { ...file(1), file: "f2", name: "photo.jpeg" }, { ...file(4), file: "f3", name: "c.pdf" }],
		[change({ files: [2], color: true }), change({ files: [3], copies: 2, pageType: "A3" })]
	);
	const cost = {
		lines: [
			{ item: "A4 B&W", quantity: 6, rate: 8, subtotal: 48 },
			{ item: "A4 Color", quantity: 1, rate: 6, subtotal: 6 },
			{ item: "A3 B&W", quantity: 4, rate: 10, subtotal: 40 },
		],
		extra: [{ item: "Service fee", subtotal: 5 }],
		total: 99,
	};
	assert.equal(
		describeOrder({ files }, cost, T.en),
		[
			"• `a.pdf`",
			"   A4 B&W: 6 × Rs. 8 = Rs. 48",
			"• `photo.jpeg` (color)",
			"   A4 Color: 1 × Rs. 6 = Rs. 6",
			"• `c.pdf` (A3, 2 copies)",
			"   A3 B&W: 4 × Rs. 10 = Rs. 40",
			"• Service fee: Rs. 5",
		].join("\n")
	);

	// Cost lines that don't line up with the files are left out, not misattributed.
	assert.equal(describeOrder({ files }, { ...cost, lines: cost.lines.slice(1) }, T.en).split("\n")[1], "• `photo.jpeg` (color)");
});

test("a flip edge is only mentioned when it isn't the orientation's", () => {
	const named = applyChanges([file(2)], [change({ duplex: "short" })]);
	assert.equal(describeOrder({ files: named }, null, T.en), "• `a.pdf` (flip on short edge)");
	const landscape = applyChanges([file(2)], [change({ orientation: "landscape" })]);
	assert.equal(describeOrder({ files: landscape }, null, T.en), "• `a.pdf` (landscape)");
});

test("pages with the same settings share one draft entry, even apart", () => {
	const files = applyChanges([file(6)], [change({ files: [1], pages: "2,5", color: true })]);
	assert.deepEqual(draftOf(files).map((f) => [f.settings.pageSelection, f.settings.color]), [
		["1,3-4,6", false],
		["2,5", true],
	]);
});

test("changes for all files reach every file; page ranges are clamped per file", () => {
	const files = applyChanges([file(12), { ...file(3), file: "f2", name: "b.pdf" }], [
		change({ color: true }),
		change({ pages: "3-10", copies: 3 }),
	]);
	assert.deepEqual(draftOf(files).map((f) => [f.file, f.settings.pageSelection, f.settings.numberOfCopies]), [
		["f1", "1-2,11-12", 1],
		["f1", "3-10", 3],
		["f2", "1-2", 1],
		["f2", "3", 3],
	]);
});

test("double-sided follows the orientation unless the flip edge is named", () => {
	const turned = applyChanges([file(2)], [change({ orientation: "landscape" })]);
	assert.equal(draftOf(turned)[0].settings.sidedness, "short");
	const named = applyChanges(turned, [change({ duplex: "long" })]);
	assert.equal(draftOf(named)[0].settings.sidedness, "long");
	const upright = applyChanges(named, [change({ orientation: "portrait" }), change({ sides: "single" }), change({ sides: "double" })]);
	assert.equal(draftOf(upright)[0].settings.sidedness, "long");
});

test("copies are kept within the backend's limit", () => {
	const files = applyChanges([file(1)], [change({ copies: 500 })]);
	assert.equal(draftOf(files)[0].settings.numberOfCopies, 100);
});

test("the inference context describes each file's runs in the model's words", () => {
	const files = applyChanges([file(12)], [change({ files: [1], pages: "1", color: true, sides: "single" })]);
	assert.deepEqual(toContextFile(files[0]), {
		name: "a.pdf",
		pages: 12,
		parts: [
			{ pages: "1", print: true, color: true, pageType: "A4", sides: "single", duplex: null, orientation: "portrait", pagesPerSheet: 1, copies: 1 },
			{ pages: "2-12", print: true, color: false, pageType: "A4", sides: "double", duplex: "long", orientation: "portrait", pagesPerSheet: 1, copies: 1 },
		],
	});
});

test("language is guessed from Urdu script or common Roman Urdu words", () => {
	assert.equal(detectLanguage("سب رنگین"), "urdu");
	assert.equal(detectLanguage("saab ko color mein"), "roman_urdu");
	assert.equal(detectLanguage("is this in color?"), null);
});

// ── The conversation ─────────────────────────────────────────────────────────

test("a burst of files gets one reply, after the last one", async () => {
	const { add, calls } = setup();
	assert.equal(await add("f1", "a.pdf", 12, { morePending: true }), null);
	assert.equal(await add("f2", "b.pdf", 3, { morePending: true }), null);
	const reply = await add("f3", "c.pdf", 12);
	assert.equal(
		reply,
		"Print settings for these files?\nDefault is *A4, black & white, double-sided*\nReply with your print settings, or *confirm* to use the default."
	);
	assert.equal(calls.filter((c) => c[0] === "create").length, 1);

	assert.match(await add("f4", "d.pdf", 1), /^Print settings for this file\?\n/);
});

test("a held-back reply is sent by flush when the batch's last file fails", async () => {
	const { flow, add } = setup();
	await add("f1", "a.pdf", 2, { morePending: true });
	assert.match(flow.flush("shop1", customer), /^Print settings for this file\?/);
	assert.equal(flow.flush("shop1", customer), null);
});

test("the files-received reply follows the customer's language", async () => {
	const { add, say, script } = setup();
	await add("f1", "a.pdf", 2);
	script.push({ success: true, status: 200, data: { intent: "offtopic", language: "roman_urdu", changes: [], question: "" } });
	await say("acha ek aur bhejta hoon");
	assert.match(await add("f2", "b.pdf", 2), /^Is file ki print settings\?\nDefault hai \*A4, black & white, double side\*/);
});

test("a settings message is read once, applied, and answered with the total", async () => {
	const { add, say, script, inferences, lastFiles, entry } = setup();
	await add("f1", "thesis.docx", 12);
	script.push(inferred({
		language: "roman_urdu",
		changes: [change({ files: [1], color: false, sides: "single" }), change({ files: [1], pages: "1", color: true })],
	}));

	const reply = await say("iss ka pehla page color mein, baqi black white, single side");
	assert.equal(inferences.length, 1);
	assert.equal(inferences[0].shop, "shop1");
	assert.equal(inferences[0].files[0].pages, 12);
	assert.equal(inferences[0].history[0].from, "shop"); // the "received" reply
	assert.deepEqual(lastFiles().map((f) => f.settings.pageSelection), ["1", "2-12"]);
	assert.equal(
		reply,
		"Theek hai ✅\n\n" +
			"• `thesis.docx` (single side)\n" +
			"   page 1 color — A4 Color: 2 × Rs. 10 = Rs. 20\n" +
			"   pages 2-12 black & white — A4 B&W: 2 × Rs. 4 = Rs. 8\n\n" +
			"*Total: Rs. 48*\nOrder dene ke liye *confirm* likhen."
	);
	assert.equal(entry().awaiting, "confirm");
	assert.equal(entry().language, "roman_urdu");
});

test("after the total, a yes-word places the order without the LLM", async () => {
	const { add, say, script, inferences, calls, entry } = setup();
	await add("f1", "a.pdf", 2);
	script.push(inferred({ changes: [change({ color: true })] }));
	await say("all color please");

	assert.match(await say("Ok 👍🏻"), /^Your job has been submitted!\n\nJob code: \*#0427\*\nTotal cost: Rs\.48$/);
	assert.equal(inferences.length, 1);
	assert.equal(calls.at(-1)[0], "submit");
	assert.equal(entry(), undefined);
});

test("confirm before any total shows the total first; yes-words alone do nothing", async () => {
	const { add, say, inferences, calls } = setup();
	await add("f1", "a.pdf", 2);
	assert.equal(await say("ok"), null);
	assert.equal(await say("thanks!"), null);
	assert.equal(await say("🙏"), null);
	assert.equal(inferences.length, 0);

	const review = await say("confirm");
	assert.match(review, /^Your order:\n\n• `a\.pdf`\n   A4 B&W: 2 × Rs\. 4 = Rs\. 8\n\n\*Total: Rs\. 48\*/);
	assert.ok(!calls.some((c) => c[0] === "submit"));
	assert.match(await say("confirm"), /submit/);
	assert.equal(inferences.length, 0);
});

test("a new file after the total means seeing the total again", async () => {
	const { add, say } = setup();
	await add("f1", "a.pdf", 2);
	await say("confirm");
	await add("f2", "b.pdf", 2);
	assert.equal(await say("yes"), null);
	assert.match(await say("confirm"), /^Your order:/);
});

test("price questions show the total; off-topic chat stays silent", async () => {
	const { add, say, script, entry } = setup();
	await add("f1", "a.pdf", 2);
	script.push(inferred({ intent: "price" }));
	assert.match(await say("how much?"), /^Your order:[\s\S]*\*Total: Rs\. 48\*/);

	script.push(inferred({ intent: "offtopic", language: "roman_urdu" }));
	assert.equal(await say("kab tak ready hoga?"), null);
	assert.equal(entry().history.at(-1).text, "kab tak ready hoga?");
});

test("unclear messages get the model's question, or an example", async () => {
	const { add, say, script } = setup();
	await add("f1", "a.pdf", 2);
	script.push(inferred({ intent: "unclear", question: "Which file, the first or the second?" }));
	assert.equal(await say("that one"), "Which file, the first or the second?");
	script.push(inferred({ intent: "settings", changes: [] }));
	assert.match(await say("do the thing"), /^Sorry, I didn't get that/);
});

test("when the LLM can't be reached, the customer gets an example to follow", async () => {
	const { add, say, script, calls } = setup();
	await add("f1", "a.pdf", 2);
	const before = calls.length;
	script.push({ success: false, status: 502, message: "inference failed" });
	assert.equal(await say("sab color"), "Maaf kijiye, samajh nahi aaya. Jaise likhen: *sab color, double side, 2 copies*");
	assert.equal(calls.length, before); // the draft wasn't touched
});

test("cancel is a keyword; the LLM reading 'cancel' only asks to be sure", async () => {
	const { add, say, script, calls, inferences, entry } = setup();
	await add("f1", "a.pdf", 2);
	script.push(inferred({ intent: "cancel" }));
	assert.equal(await say("rehne do yaar"), "Reply *cancel* to cancel your order.");
	assert.ok(entry());

	assert.equal(await say("Cancel kardo"), "Aap ka order cancel kar diya gaya hai."); // Roman Urdu, so replied in it
	assert.equal(calls.at(-1)[0], "delete");
	assert.equal(inferences.length, 1);
	assert.equal(entry(), undefined);
});

test("without an order, only confirm and cancel get an answer", async () => {
	const { say, inferences } = setup();
	assert.equal(await say("hello"), null);
	assert.equal(await say("confirm"), "Send me the files you want printed first.");
	assert.equal(await say("cancel"), "You don't have an order to cancel.");
	assert.equal(inferences.length, 0);
});

test("leaving nothing to print is refused", async () => {
	const { add, say, script, lastFiles } = setup();
	await add("f1", "a.pdf", 2);
	script.push(inferred({ changes: [change({ files: [1], pages: "5", only: true })] }));
	assert.match(await say("only page 5"), /nothing to print/);
	assert.deepEqual(lastFiles().map((f) => f.settings.pageSelection), [""]);
});

test("a failed price check keeps the order open without asking for a yes", async () => {
	const { add, say, script, api, entry } = setup();
	await add("f1", "a.pdf", 2);
	api.failCheck = true;
	script.push(inferred({ changes: [change({ color: true })] }));
	assert.match(await say("all color"), /couldn't work out your total: unable to price job/);
	assert.equal(entry().awaiting, null);
	assert.equal(await say("yes"), null);
});

test("a draft gone from the backend is recreated when pricing", async () => {
	const { add, say, backend, calls } = setup();
	await add("f1", "a.pdf", 2);
	backend.clear();
	assert.match(await say("confirm"), /\*Total: Rs\. 48\*/);
	assert.equal(calls.filter((c) => c[0] === "create").length, 2);
	assert.match(await say("confirm"), /submit/);
});

test("replies follow the customer's language", async () => {
	const { add, say, script } = setup();
	await add("f1", "a.pdf", 2);
	script.push(inferred({ language: "urdu", changes: [change({ color: true })] }));
	const reply = await say("سب رنگین");
	assert.match(reply, /^ٹھیک ہے ✅/);
	assert.match(reply, /\*کل: Rs\. 48\*/);
	assert.match(await say("جی"), /^آپ کی جاب جمع ہو گئی ہے!/);
});

// ── Paying ────────────────────────────────────────────────────────────────────

const wallet = { bank: "Meezan Bank", title: "Ali Prints", number: "PK36SCBL0000001123456702" };

// A draft whose total (48) has been shown, ready to confirm.
async function readyToPay(shop) {
	const s = setup();
	s.api.shop = shop;
	await s.add("f1", "a.pdf", 2);
	await s.say("confirm");
	return s;
}

test("under the COD limit with a wallet, the customer picks cash or online", async () => {
	const { say, calls, inferences, entry } = await readyToPay({ codLimit: 500, wallet });
	const ask = await say("confirm");
	assert.equal(ask, "How would you like to pay?\n• *cash*: pay when you collect\n• *online*: pay now by bank transfer");
	assert.equal(entry().awaiting, "payment");
	assert.ok(!calls.some((c) => c[0] === "submit"));

	assert.equal(await say("ok"), ask); // a yes doesn't pick for them
	assert.equal(
		await say("Cash on pickup"),
		"Your job has been submitted!\n\nJob code: *#0427*\nTotal cost: Rs.48"
	);
	assert.equal(inferences.length, 0);
	assert.ok(!calls.filter((c) => c[0] === "update").some((c) => c[2].paymentProofFile));
});

test("paying online shows the shop's account, and the screenshot places the order", async () => {
	const { say, add, calls, entry } = await readyToPay({ codLimit: 500, wallet });
	await say("confirm");
	assert.deepEqual(await say("online"), [
		"Transfer *Rs. 48* to the *Meezan Bank* account,\nAnd then send a screenshot of the payment confirmation.",
		"Meezan Bank\nAli Prints",
		"PK36SCBL0000001123456702",
	]);
	assert.equal(entry().awaiting, "proof");
	assert.equal(await say("sending it now"), "Please send a screenshot of your payment to place your order.");

	const placed = await add("p1", "IMG-20261001-143012.jpg", 1);
	assert.equal(placed, "Your job has been submitted!\n\nJob code: *#0427*\nTotal cost: Rs.48");
	const update = calls.filter((c) => c[0] === "update").at(-1);
	assert.equal(update[2].paymentProofFile, "p1");
	assert.deepEqual(update[2].files.map((f) => f.file), ["f1"]); // the screenshot isn't printed
	assert.equal(calls.at(-1)[0], "submit");
});

test("at or over the COD limit, the order must be paid online", async () => {
	const { say, entry } = await readyToPay({ codLimit: 48, wallet });
	assert.match((await say("confirm"))[0], /^Orders of Rs\. 48 or more are paid online\.\nTransfer \*Rs\. 48\* to the/);
	assert.equal(entry().awaiting, "proof");
	// Cash isn't on offer: the request for the screenshot is repeated.
	assert.equal(await say("cash"), "Please send a screenshot of your payment to place your order.");
	assert.equal(entry().awaiting, "proof");
});

test("a shop without a COD limit takes online payment only", async () => {
	const { say } = await readyToPay({ wallet });
	assert.match((await say("confirm"))[0], /^Transfer \*Rs\. 48\* to the/);
});

test("a shop with a COD limit but no wallet takes the order as cash", async () => {
	const { say } = await readyToPay({ codLimit: 500 });
	assert.match(await say("confirm"), /^Your job has been submitted!\n\nJob code: \*#0427\*\nTotal cost: Rs\.\d+$/);
});

test("when the shop can't be loaded, confirming can be retried", async () => {
	const { say, api, entry } = await readyToPay(null);
	assert.match(await say("confirm"), /couldn't load the payment options/);
	assert.equal(entry().awaiting, "confirm");
	api.shop = { codLimit: 500 };
	assert.match(await say("confirm"), /submit/);
});

test("changing settings while paying means seeing the total again", async () => {
	const { say, script, entry } = await readyToPay({ codLimit: 500, wallet });
	await say("confirm");
	script.push(inferred({ changes: [change({ color: true })] }));
	assert.match(await say("actually make it color"), /^Done ✅[\s\S]*\*Total: Rs\. 48\*/);
	assert.equal(entry().awaiting, "confirm");
});

test("a second screenshot right after the order doesn't start a new one", async () => {
	const { say, add, calls, entry } = await readyToPay({ wallet });
	await say("confirm");
	await add("p1", "proof.jpg", 1);
	assert.equal(
		await add("p2", "proof2.jpg", 1),
		"Your order *0427* is already placed ✅ If that was a new file to print, please send it again."
	);
	assert.equal(entry(), undefined);
	assert.equal(calls.filter((c) => c[0] === "create").length, 1);
});

// ── Comments for the shop ─────────────────────────────────────────────────────

test("instructions for the shop are saved as the draft's comments", async () => {
	const { add, say, script, lastFiles, calls } = setup();
	await add("f1", "a.pdf", 2);
	script.push(inferred({ language: "roman_urdu", comment: "staple kar dena" }));
	const reply = await say("staple kar dena");
	assert.match(reply, /\n\n📝 staple kar dena\n\n\*Total: Rs\. 48\*/);
	const body = () => calls.filter((c) => c[0] === "update").at(-1)[2];
	assert.equal(body().additionalComments, "staple kar dena");
	assert.equal(lastFiles().length, 1);

	script.push(inferred({ changes: [change({ color: true })], comment: "urgent please" }));
	await say("all color, urgent please");
	assert.equal(body().additionalComments, "staple kar dena\nurgent please");

	// A confirm that carries an instruction saves it, then confirms.
	script.push(inferred({ intent: "confirm", comment: "spiral binding" }));
	assert.match(await say("theek hai, spiral binding bhi kar dena"), /submit/);
	assert.equal(body().additionalComments, "staple kar dena\nurgent please\nspiral binding");
});
