// Operator overrides of a document's print settings: validation, how an override
// is layered over the customer's settings, and that the real print engine prints
// with — and only with — what the operator chose.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { loadEngine, settle } = require("./helpers/engineHarness");

const { sanitizeSettingsPatch, applySettingsPatch, mergeOverride, effectiveSettings } = require(path.join(__dirname, "..", "main", "fileSettings.js"));

const customer = { pageType: "A4", color: false, sidedness: "none", numberOfCopies: 2, pageSelection: "1-3" };

test("a well-formed change is accepted as given", () => {
	assert.deepEqual(
		sanitizeSettingsPatch({ pageType: "A3", color: true, sidedness: "long", orientation: "landscape", numberOfCopies: "4", pagesPerSheet: 2 }),
		{ patch: { pageType: "A3", color: true, sidedness: "long", orientation: "landscape", numberOfCopies: 4, pagesPerSheet: 2 } }
	);
});

test("page ranges are tidied, and blank or \"all\" means every page", () => {
	assert.deepEqual(sanitizeSettingsPatch({ pageSelection: " 1 - 3,5 " }), { patch: { pageSelection: "1-3, 5" } });
	assert.deepEqual(sanitizeSettingsPatch({ pageSelection: "" }), { patch: { pageSelection: "" } });
	assert.deepEqual(sanitizeSettingsPatch({ pageSelection: "All pages" }), { patch: { pageSelection: "" } });
});

test("malformed values are refused with a reason", () => {
	for (const bad of [
		{ pageSelection: "one to three" },
		{ pageSelection: "5-2" },
		{ pageSelection: "0" },
		{ numberOfCopies: 0 },
		{ numberOfCopies: 2.5 },
		{ numberOfCopies: 1000 },
		{ pagesPerSheet: 3 },
		{ sidedness: "both" },
		{ orientation: "sideways" },
		{ color: "yes" },
		{ pageType: "" },
		{ staple: true },
	]) {
		assert.ok(sanitizeSettingsPatch(bad).error, `accepted ${JSON.stringify(bad)}`);
	}
});

test("an override keeps only what differs from the customer's choice", () => {
	assert.deepEqual(mergeOverride(customer, null, { color: true, numberOfCopies: 2 }), { color: true });
	// Setting a value back to the customer's removes it; nothing left → no override.
	assert.equal(mergeOverride(customer, { color: true }, { color: false }), null);
	// Unset customer values count as their defaults: all pages, one copy.
	assert.equal(mergeOverride({}, null, { pageSelection: "", numberOfCopies: 1, pagesPerSheet: 1 }), null);
	assert.deepEqual(effectiveSettings(customer, { color: true }), { ...customer, color: true });
});

// ── Flip edge ───────────────────────────────────────────────────────────────
// Applies operator changes one after another, as the UI sends them, and returns
// the sidedness the document would print with.
function edgeAfter(original, ...patches) {
	let override = null;
	for (const patch of patches) override = applySettingsPatch(original, override, sanitizeSettingsPatch(patch).patch);
	return { sidedness: effectiveSettings(original, override).sidedness, override };
}

test("turning a single-sided document double picks the edge from the orientation", () => {
	assert.equal(edgeAfter({ sidedness: "none" }, { sides: "double" }).sidedness, "long"); // no orientation: portrait
	assert.equal(edgeAfter({ sidedness: "none", orientation: "portrait" }, { sides: "double" }).sidedness, "long");
	assert.equal(edgeAfter({ sidedness: "none", orientation: "landscape" }, { sides: "double" }).sidedness, "short");
	assert.equal(edgeAfter({}, { orientation: "landscape" }, { sides: "double" }).sidedness, "short");
});

test("that worked-out edge follows later orientation changes", () => {
	const portrait = { sidedness: "none", orientation: "portrait" };
	assert.equal(edgeAfter(portrait, { sides: "double" }, { orientation: "landscape" }).sidedness, "short");
	assert.equal(edgeAfter(portrait, { sides: "double" }, { orientation: "landscape" }, { orientation: "portrait" }).sidedness, "long");
});

test("an edge the operator picked stays put when the orientation changes", () => {
	const portrait = { sidedness: "none", orientation: "portrait" };
	const { sidedness, override } = edgeAfter(portrait, { sides: "double" }, { sidedness: "long" }, { orientation: "landscape" });
	assert.equal(sidedness, "long");
	assert.equal(override.duplexExplicit, true);
	assert.equal(effectiveSettings(portrait, override).duplexExplicit, undefined, "the flag never reaches the printer");
});

test("the customer's edge is honoured: switching back to double restores it, orientation never moves it", () => {
	const customerShort = { sidedness: "short", orientation: "portrait" };
	assert.equal(edgeAfter(customerShort, { sides: "single" }, { sides: "double" }).sidedness, "short");
	assert.equal(edgeAfter(customerShort, { orientation: "landscape" }).sidedness, "short");
	assert.equal(edgeAfter({ sidedness: "long" }, { orientation: "landscape" }).sidedness, "long");
	// …unless the operator sets the edge explicitly.
	assert.equal(edgeAfter(customerShort, { sidedness: "long" }, { orientation: "landscape" }).sidedness, "long");
});

test("going back to single-sided forgets an explicit edge", () => {
	const portrait = { sidedness: "none", orientation: "portrait" };
	const { sidedness, override } = edgeAfter(
		portrait,
		{ sides: "double" },
		{ sidedness: "long" },
		{ sides: "single" },
		{ orientation: "landscape" },
		{ sides: "double" }
	);
	assert.equal(sidedness, "short", "worked out from the orientation again");
	assert.equal(override.duplexExplicit, undefined);
	// Back to exactly what the customer sent → no override at all.
	assert.equal(edgeAfter(portrait, { sides: "double" }, { sides: "single" }).override, null);
});

const job = (id, settings = customer) => ({
	_id: id,
	status: "submitted",
	additionalComments: "",
	files: [{ file: { _id: `${id}-f1`, name: "doc.pdf" }, settings }],
});

test("a document prints with the operator's settings, not the customer's", async () => {
	const { engine, state } = loadEngine({ jobs: [job("j1")] });
	engine.start();
	engine.onJobsReconciled(state.jobs);

	assert.deepEqual(engine.setFileSettings("j1", "j1-f1", { color: true, numberOfCopies: 1 }), { success: true });
	assert.deepEqual(engine.getSnapshot().settingsOverrides, { j1: { "j1-f1": { color: true, numberOfCopies: 1 } } });

	await engine.printFile("j1", "j1-f1");
	await settle();
	assert.deepEqual(state.printed[0].settings, { ...customer, color: true, numberOfCopies: 1 });
	engine.stop();
});

test("a queued document picks up a change made while it waits", async () => {
	const { engine, state } = loadEngine({ jobs: [job("j2")] });
	state.readyFiles = new Set(); // still downloading, so the print waits
	engine.start();
	engine.onJobsReconciled(state.jobs);
	await engine.printFile("j2", "j2-f1");
	await settle();
	assert.equal(state.printed.length, 0);

	engine.setFileSettings("j2", "j2-f1", { pageType: "A3" });
	state.readyFiles.add("j2-f1");
	for (const listener of state.statusListeners) listener("j2-f1", "ready");
	await settle();
	assert.equal(state.printed[0].settings.pageType, "A3");
	engine.stop();
});

test("reset restores the customer's settings", async () => {
	const { engine, state } = loadEngine({ jobs: [job("j3")] });
	engine.start();
	engine.onJobsReconciled(state.jobs);
	engine.setFileSettings("j3", "j3-f1", { sidedness: "long" });
	assert.deepEqual(engine.setFileSettings("j3", "j3-f1", null), { success: true });
	assert.deepEqual(engine.getSnapshot().settingsOverrides, {});

	await engine.printFile("j3", "j3-f1");
	await settle();
	assert.deepEqual(state.printed[0].settings, customer);
	engine.stop();
});

test("changes are refused once a document has printed or its job has closed, and bad values never land", async () => {
	const twoDocs = job("j4");
	twoDocs.files.push({ file: { _id: "j4-f2", name: "second.pdf" }, settings: customer });
	const { engine, state } = loadEngine({ jobs: [twoDocs] });
	engine.start();
	engine.onJobsReconciled(state.jobs);
	assert.equal(engine.setFileSettings("j4", "j4-f1", { numberOfCopies: 0 }).success, false);
	assert.deepEqual(engine.getSnapshot().settingsOverrides, {});

	// One document printed; the job stays open for the other.
	await engine.printFile("j4", "j4-f1");
	await settle();
	const printed = engine.setFileSettings("j4", "j4-f1", { color: true });
	assert.equal(printed.success, false);
	assert.match(printed.message, /already printed/);
	assert.equal(engine.setFileSettings("j4", "j4-f2", { color: true }).success, true);

	// Printing the last document completes the job — nothing can change after that.
	await engine.printFile("j4", "j4-f2");
	await settle();
	const closed = engine.setFileSettings("j4", "j4-f2", { color: false });
	assert.equal(closed.success, false);
	assert.match(closed.message, /closed/);
	engine.stop();
});

test("overrides survive a restart and are dropped once their job is gone", async () => {
	const first = loadEngine({ jobs: [job("j5")] });
	first.engine.start();
	first.engine.onJobsReconciled(first.state.jobs);
	first.engine.setFileSettings("j5", "j5-f1", { orientation: "landscape" });
	first.engine.stop();
	const saved = first.state.store.get("fileSettingsOverrides");
	assert.deepEqual(saved, { j5: { "j5-f1": { orientation: "landscape" } } });

	const second = loadEngine({ jobs: [job("j5")], storeData: { fileSettingsOverrides: saved } });
	second.engine.start();
	second.engine.onJobsReconciled(second.state.jobs);
	assert.deepEqual(second.engine.getSnapshot().settingsOverrides, saved);

	second.engine.onJobsReconciled([]); // the job left the backend's list
	assert.deepEqual(second.engine.getSnapshot().settingsOverrides, {});
	second.engine.stop();
});

test("the file card and list rows show what will actually print", async () => {
	const { transformJob, applySettingsOverrides } = await import("../renderer/src/dashboard/jobUtils.js");
	const entry = transformJob({ _id: "j6", status: "queued", createdAt: new Date().toISOString(), files: job("j6").files });
	const shown = applySettingsOverrides(entry, { "j6-f1": { color: true, numberOfCopies: 5 } });
	assert.equal(shown.files[0].settings.color, true);
	assert.equal(shown.files[0].originalSettings.color, false);
	assert.deepEqual(shown.files[0].overriddenKeys, ["color", "numberOfCopies"]);
	assert.equal(shown.copies, 5);
	assert.equal(shown.color, true);
	assert.equal(applySettingsOverrides(entry, undefined), entry);
});
