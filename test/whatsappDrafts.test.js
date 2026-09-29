// A WhatsApp customer's draft (main/whatsappDrafts.js): one draft per customer
// that each document is added to, a numbered settings menu where two-way
// settings flip in place, "confirm" twice (see the total, then submit) and
// "cancel" to delete it. Runs against an in-memory fake of the drafts API.
//
// Menu numbers: 1 Size, 2 Color, 3 Sides | 4 Pages, 5 Copies, 6 Pages per sheet,
// 7 Orientation, 8 Duplex (double-sided only) | then, with several files,
// change another file and use these settings for all.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { textOf, createDraftManager } = require("../main/whatsappDrafts");
const { DEFAULT_SETTINGS } = require("../main/whatsappSettings");

const customer = { name: "Ali Khan", number: "923001234567" };
const cost = {
	lines: [{ item: "A4-BW", quantity: 4, rate: 10, subtotal: 40 }],
	extra: [{ item: "Service fee", subtotal: 5 }],
	total: 45,
};

// A fake backend: drafts by id, every call recorded.
function setup() {
	const backend = new Map();
	const calls = [];
	let nextId = 1;
	let saved = {};
	const api = {
		failUpdate: false,
		failDelete: false,
		failCheck: false,
		async createDraft(body) {
			calls.push(["create", body]);
			const draft = { _id: `d${nextId++}`, ...body };
			backend.set(draft._id, draft);
			return { success: true, status: 201, data: draft };
		},
		async updateDraft(id, body) {
			calls.push(["update", id, body]);
			if (api.failUpdate) return { success: false, status: 500, message: "db down" };
			if (!backend.has(id)) return { success: false, status: 404, message: "draft not found" };
			backend.set(id, { _id: id, ...body });
			return { success: true, status: 200, data: backend.get(id) };
		},
		async checkDraft(id) {
			calls.push(["check", id]);
			if (api.failCheck) return { success: false, status: 500, message: "no service" };
			if (!backend.has(id)) return { success: false, status: 404, message: "draft not found" };
			return { success: true, status: 200, data: { ...backend.get(id), cost } };
		},
		async submitDraft(id) {
			calls.push(["submit", id]);
			if (!backend.has(id)) return { success: false, status: 404, message: "draft not found" };
			backend.delete(id);
			return { success: true, status: 200, data: { _id: "j1", code: "0427", cost } };
		},
		async deleteDraft(id) {
			calls.push(["delete", id]);
			if (api.failDelete) return { success: false, status: 500, message: "db down" };
			if (!backend.delete(id)) return { success: false, status: 404, message: "draft not found" };
			return { success: true, status: 200 };
		},
	};
	const manager = createDraftManager({ api, load: () => structuredClone(saved), save: (map) => (saved = map) });
	const say = (text) => manager.handleText("shop1", customer, text);
	const lastBody = () => calls.filter((c) => c[0] === "update" || c[0] === "create").at(-1).at(-1);
	const settings = (i = 0) => lastBody().files[i].settings;
	return { manager, api, backend, calls, say, lastBody, settings, saved: () => saved };
}

test("the first document creates a draft with the default settings and shows the menu", async () => {
	const { manager, calls } = setup();
	const reply = await manager.addFile("shop1", customer, { _id: "f1", numberOfPages: 3 }, "notes.docx");

	assert.deepEqual(calls, [
		[
			"create",
			{ source: "shop", channel: "whatsapp", shop: "shop1", customer, files: [{ file: "f1", settings: DEFAULT_SETTINGS }] },
		],
	]);
	assert.equal(DEFAULT_SETTINGS.sidedness, "long");
	assert.equal(
		reply,
		[
			"✅ Added to your order `notes.docx`",
			"(3 pages)",
			"",
			"Reply with a number to change a setting",
			"1️⃣ Size: A4",
			"2️⃣ Color: Black & white",
			"3️⃣ Sides: Double",
			"",
			"4️⃣ Pages: All",
			"5️⃣ Copies: 1",
			"6️⃣ Pages per sheet: 1",
			"7️⃣ Orientation: Portrait",
			"8️⃣ Duplex: Flip on long edge (auto)",
			"",
			"Reply with *confirm* or *cancel*",
		].join("\n")
	);
});

test("later documents are added to the same draft with the full file list", async () => {
	const { manager, calls, lastBody } = setup();
	await manager.addFile("shop1", customer, { _id: "f1", numberOfPages: 1 }, "a.pdf");
	const reply = await manager.addFile("shop1", customer, { _id: "f2", numberOfPages: 1 }, "b.pdf");

	assert.equal(calls.find((c) => c[0] === "update")[1], "d1");
	assert.deepEqual(lastBody().files.map((f) => f.file), ["f1", "f2"]);
	assert.match(reply, /^✅ Added to your order `b\.pdf`\n\(1 page · file 2 of 2\)\n\n/);
	assert.match(reply, /\n\n9️⃣ Change another file's settings\n🔟 Use these settings for all files\n/);
});

test("each customer gets their own draft", async () => {
	const { manager, calls } = setup();
	await manager.addFile("shop1", customer, { _id: "f1" }, "a.pdf");
	await manager.addFile("shop1", { name: "Sara", number: "923111111111" }, { _id: "f2" }, "b.pdf");
	assert.equal(calls.filter((c) => c[0] === "create").length, 2);
});

test("a draft gone from the backend is recreated with every file", async () => {
	const { manager, backend, calls } = setup();
	await manager.addFile("shop1", customer, { _id: "f1" }, "a.pdf");
	backend.clear();
	await manager.addFile("shop1", customer, { _id: "f2" }, "b.pdf");

	const creates = calls.filter((c) => c[0] === "create");
	assert.equal(creates.length, 2);
	assert.deepEqual(creates[1][1].files.map((f) => f.file), ["f1", "f2"]);
});

test("a failed create tells the customer and remembers nothing", async () => {
	const m = createDraftManager({
		api: { createDraft: async () => ({ success: false, status: 500, message: "boom" }) },
		load: () => ({}),
		save: () => assert.fail("nothing should be saved"),
	});
	assert.match(await m.addFile("shop1", customer, { _id: "f1" }, "a.pdf"), /couldn't add `a\.pdf`.*boom/);
});

// ── Settings menu ─────────────────────────────────────────────────────────────

test("two-way settings flip straight away", async () => {
	const { manager, say, settings } = setup();
	await manager.addFile("shop1", customer, { _id: "f1" }, "a.pdf");

	const reply = await say("2");
	assert.equal(settings().color, true);
	assert.match(reply, /^✅ Color changed to \*Color\* for `a\.pdf`\n/);
	assert.match(reply, /2️⃣ Color: Color/);

	await say("2");
	assert.equal(settings().color, false);
	await say("1");
	assert.equal(settings().pageType, "A3");
	await say("1");
	assert.equal(settings().pageType, "A4");
});

test("single-sided hides duplex, and double-sided brings it back", async () => {
	const { manager, say, settings } = setup();
	await manager.addFile("shop1", customer, { _id: "f1" }, "a.pdf");

	const single = await say("3");
	assert.equal(settings().sidedness, "none");
	assert.match(single, /3️⃣ Sides: Single/);
	assert.doesNotMatch(single, /Duplex/);
	assert.match(await say("8"), /from 1 to 7/);

	await say("3");
	assert.equal(settings().sidedness, "long");
});

test("duplex follows the orientation until it's set explicitly", async () => {
	const { manager, say, settings } = setup();
	await manager.addFile("shop1", customer, { _id: "f1" }, "a.pdf");

	// Landscape flips on the short edge, portrait on the long one.
	assert.match(await say("7"), /8️⃣ Duplex: Flip on short edge \(auto\)/);
	assert.equal(settings().sidedness, "short");
	await say("7");
	assert.equal(settings().sidedness, "long");

	// Once picked it stays, whatever the orientation…
	assert.match(await say("8"), /^✅ Duplex changed to \*Flip on short edge\* for `a\.pdf`/);
	assert.equal(settings().sidedness, "short");
	assert.match(await say("7"), /8️⃣ Duplex: Flip on short edge\n/); // no "(auto)"
	assert.equal(settings().orientation, "landscape");
	await say("7");
	assert.equal(settings().sidedness, "short");

	// …and across single and back to double.
	await say("3");
	assert.equal(settings().sidedness, "none");
	await say("3");
	assert.equal(settings().sidedness, "short");
});

test("pages per sheet opens a list of choices", async () => {
	const { manager, say, settings } = setup();
	await manager.addFile("shop1", customer, { _id: "f1" }, "a.pdf");

	assert.match(await say("6"), /\*Pages per sheet\* for `a\.pdf`:\n1️⃣ 1 ✓\n2️⃣ 2\n3️⃣ 4\n4️⃣ 8\n5️⃣ 16/);
	assert.match(await say("9"), /from 1 to 5/);
	assert.match(await say("3"), /Pages per sheet changed to \*4\* for `a\.pdf`/);
	assert.equal(settings().pagesPerSheet, 4);
});

test("copies are typed in and checked", async () => {
	const { manager, say, settings, calls } = setup();
	await manager.addFile("shop1", customer, { _id: "f1" }, "a.pdf");

	assert.match(await say("5"), /How many copies of `a\.pdf`\?/);
	const updatesBefore = calls.filter((c) => c[0] === "update").length;
	assert.match(await say("lots"), /number of copies/);
	assert.match(await say("0"), /📄 `a\.pdf`/); // 0 goes back
	assert.equal(calls.filter((c) => c[0] === "update").length, updatesBefore);

	await say("5");
	assert.match(await say("5000"), /between 1 and 1000/);
	assert.match(await say("3"), /Copies changed to \*3\*/);
	assert.equal(settings().numberOfCopies, 3);
});

test("page selections accept ranges and all, and refuse pages past the end", async () => {
	const { manager, say, settings } = setup();
	await manager.addFile("shop1", customer, { _id: "f1", numberOfPages: 10 }, "a.pdf");

	assert.match(await say("4"), /it has 10 pages/);
	assert.match(await say("3-1"), /isn't a valid page range/);
	assert.match(await say("12"), /only has 10 pages/);
	assert.match(await say("1-3, 5, 8-"), /Pages changed to \*1-3,5,8-\*/);
	assert.equal(settings().pageSelection, "1-3,5,8-");

	await say("4");
	await say("ALL");
	assert.equal(settings().pageSelection, "");
});

test("with several files, the menu can switch files and copy settings to all", async () => {
	const { manager, say, lastBody } = setup();
	await manager.addFile("shop1", customer, { _id: "f1" }, "a.pdf");
	await manager.addFile("shop1", customer, { _id: "f2" }, "b.pdf");

	// The menu starts on the newest file.
	await say("2");
	assert.deepEqual(lastBody().files.map((f) => f.settings.color), [false, true]);

	assert.match(await say("9"), /1️⃣ `a\.pdf`\n2️⃣ `b\.pdf` ✓/);
	assert.match(await say("3"), /from 1 to 2/);
	assert.match(await say("1"), /^📄 `a\.pdf`\n\(file 1 of 2\)\n\n/);
	await say("1"); // A3
	await say("8"); // explicit short-edge duplex
	assert.deepEqual(lastBody().files.map((f) => f.settings.pageType), ["A3", "A4"]);

	assert.match(await say("10"), /Every file now uses the settings of `a\.pdf`/);
	assert.deepEqual(lastBody().files[1].settings, lastBody().files[0].settings);
	assert.equal(lastBody().files[1].settings.color, false);

	// The copied duplex choice is explicit on the other file too.
	await say("9");
	await say("2");
	assert.match(await say("7"), /8️⃣ Duplex: Flip on short edge\n/);
});

test("an unknown menu number is refused, and chat that isn't for the menu is ignored", async () => {
	const { manager, say } = setup();
	assert.equal(await say("2"), null); // no draft: not our business
	await manager.addFile("shop1", customer, { _id: "f1" }, "a.pdf");
	assert.match(await say("9"), /from 1 to 8/);
	assert.equal(await say("thanks!"), null);
	assert.match(await say("Menu"), /📄 `a\.pdf`/);
});

test("a failed settings change keeps the old settings", async () => {
	const { manager, api, say, saved } = setup();
	await manager.addFile("shop1", customer, { _id: "f1" }, "a.pdf");
	api.failUpdate = true;
	assert.match(await say("2"), /couldn't update your order: db down/);
	const [entry] = Object.values(saved());
	assert.equal(entry.files[0].settings.color, false);
	assert.equal(entry.awaiting, null);
});

test("a new document ends any half-answered setting", async () => {
	const { manager, say } = setup();
	await manager.addFile("shop1", customer, { _id: "f1" }, "a.pdf");
	await say("5"); // asked for copies
	await manager.addFile("shop1", customer, { _id: "f2" }, "b.pdf");
	assert.match(await say("6"), /\*Pages per sheet\* for `b\.pdf`/); // "6" is a menu pick again
});

// ── confirm / cancel ──────────────────────────────────────────────────────────

test("the first confirm shows the order and its total, the second submits it", async () => {
	const { manager, calls, say, saved } = setup();
	await manager.addFile("shop1", customer, { _id: "f1" }, "a.pdf");
	await say("5");
	await say("2");
	await manager.addFile("shop1", customer, { _id: "f2" }, "b.pdf");
	await say("3"); // b.pdf single-sided

	const review = await say("confirm");
	assert.equal(calls.at(-1)[0], "check");
	assert.match(review, /\*Your order\* \(2 files\)\n1️⃣ `a\.pdf`: A4, Black & white, Double-sided, 2 copies\n2️⃣ `b\.pdf`: A4, Black & white, Single-sided/);
	assert.match(review, /A4-BW: 4 × Rs\. 10 = Rs\. 40\n• Service fee: Rs\. 5\n\*Total: Rs\. 45\*/);
	assert.match(review, /\n\n• \*confirm\* again to place your order\n• \*menu\* to change something$/);
	assert.ok(!calls.some((c) => c[0] === "submit"));

	const placed = await say("  Confirm! ");
	assert.deepEqual(calls.at(-1), ["submit", "d1"]);
	assert.match(placed, /placed/);
	assert.match(placed, /\*0427\*/);
	assert.match(placed, /Total: Rs\. 45/);
	assert.deepEqual(saved(), {});

	// The next document starts a new draft.
	await manager.addFile("shop1", customer, { _id: "f3" }, "c.pdf");
	assert.equal(calls.filter((c) => c[0] === "create").length, 2);
});

test("changing anything after the total means confirming again", async () => {
	const { manager, calls, say } = setup();
	await manager.addFile("shop1", customer, { _id: "f1" }, "a.pdf");
	await say("confirm");
	await say("2"); // a change
	assert.match(await say("confirm"), /\*Total: Rs\. 45\*/);

	await manager.addFile("shop1", customer, { _id: "f2" }, "b.pdf");
	assert.match(await say("confirm"), /\*Your order\* \(2 files\)/);
	await say("menu");
	assert.match(await say("confirm"), /\*confirm\* again/);
	assert.ok(!calls.some((c) => c[0] === "submit"));
	await say("confirm");
	assert.equal(calls.at(-1)[0], "submit");
});

test("confirm works in the middle of answering a setting", async () => {
	const { manager, say } = setup();
	await manager.addFile("shop1", customer, { _id: "f1" }, "a.pdf");
	await say("5");
	assert.match(await say("confirm"), /\*Total: Rs\. 45\*/);
});

test("a failed price check doesn't let the order through", async () => {
	const { manager, api, calls, say } = setup();
	await manager.addFile("shop1", customer, { _id: "f1" }, "a.pdf");
	api.failCheck = true;
	assert.match(await say("confirm"), /couldn't work out your total: no service/);
	assert.match(await say("confirm"), /couldn't work out your total/);
	assert.ok(!calls.some((c) => c[0] === "submit"));
});

test("confirm on a draft gone from the backend recreates it before pricing", async () => {
	const { manager, backend, calls, say } = setup();
	await manager.addFile("shop1", customer, { _id: "f1" }, "a.pdf");
	backend.clear();
	assert.match(await say("confirm"), /\*Total: Rs\. 45\*/);
	assert.equal(calls.filter((c) => c[0] === "create").length, 2);
	await say("confirm");
	assert.deepEqual(calls.at(-1), ["submit", "d2"]);
});

test("confirm without a draft asks for a document", async () => {
	const { calls, say } = setup();
	assert.match(await say("confirm"), /Send us a document/);
	assert.equal(calls.length, 0);
});

test("cancel deletes the draft so the next document starts over", async () => {
	const { manager, backend, calls, say, saved } = setup();
	await manager.addFile("shop1", customer, { _id: "f1" }, "a.pdf");
	assert.match(await say("cancel"), /cancelled/);
	assert.deepEqual(calls.at(-1), ["delete", "d1"]);
	assert.equal(backend.size, 0);
	assert.deepEqual(saved(), {});
	assert.match(await say("cancel"), /don't have an order/);

	await manager.addFile("shop1", customer, { _id: "f2" }, "b.pdf");
	const creates = calls.filter((c) => c[0] === "create");
	assert.deepEqual(creates[1][1].files.map((f) => f.file), ["f2"]);
});

test("cancel on a draft already gone from the backend still forgets it", async () => {
	const { manager, backend, say, saved } = setup();
	await manager.addFile("shop1", customer, { _id: "f1" }, "a.pdf");
	backend.clear();
	assert.match(await say("cancel"), /cancelled/);
	assert.deepEqual(saved(), {});
});

test("a failed delete keeps the draft so cancel can be retried", async () => {
	const { manager, api, say, saved } = setup();
	await manager.addFile("shop1", customer, { _id: "f1" }, "a.pdf");
	api.failDelete = true;
	assert.match(await say("cancel"), /couldn't cancel.*db down.*\*cancel\*/);
	assert.equal(Object.keys(saved()).length, 1);

	api.failDelete = false;
	assert.match(await say("cancel"), /cancelled/);
	assert.deepEqual(saved(), {});
});

test("text is read from plain and extended text messages only", () => {
	assert.equal(textOf({ message: { conversation: "hi" } }), "hi");
	assert.equal(textOf({ message: { extendedTextMessage: { text: "yo" } } }), "yo");
	assert.equal(textOf({ message: { documentMessage: {} } }), null);
});
