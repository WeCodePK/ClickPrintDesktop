// The on-disk copy of the last good history (main/historyCache.js) that the
// Dashboard and History fall back to when a fetch fails.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "clickprint-history-test-"));
let cache;

before(() => {
	const electron = require.resolve("electron");
	const mod = new Module(electron);
	mod.filename = electron;
	mod.loaded = true;
	mod.exports = { app: { getPath: () => userData } };
	require.cache[electron] = mod;
	cache = require("../main/historyCache");
});

after(() => fs.rmSync(userData, { recursive: true, force: true }));

test("nothing is served before a successful fetch has been saved", () => {
	assert.equal(cache.load("shopA"), null);
});

test("the saved history comes back with the time it was fetched", async () => {
	const jobs = [{ _id: "h1", status: "completed", cost: { total: 30 } }];
	const before = Date.now();
	await cache.save("shopA", jobs);
	const saved = cache.load("shopA");
	assert.deepEqual(saved.data.map((j) => [j._id, j.status, j.cost.total]), [["h1", "completed", 30]]);
	assert.ok(Date.parse(saved.fetchedAt) >= before - 1000);
});

test("another shop never sees this shop's history", () => {
	assert.equal(cache.load("shopB"), null);
});

test("a newer save replaces the older copy", async () => {
	await cache.save("shopA", [{ _id: "h2" }]);
	assert.deepEqual(cache.load("shopA").data.map((j) => j._id), ["h2"]);
});

test("logging out clears it", async () => {
	await cache.clear();
	assert.equal(cache.load("shopA"), null);
	await cache.clear(); // clearing twice is harmless
});

// A history job as GET /api/history/shops/:id returns it (populated).
const fullJob = (id, extra = {}) => ({
	_id: id,
	status: "completed",
	createdAt: new Date().toISOString(),
	shop: { _id: "shopA", name: "Test Shop" },
	createdBy: { _id: "u1", name: "Ali", number: "923001234567" },
	additionalComments: "Please staple",
	paymentProofFile: { _id: "p1", name: "transfer.png" },
	cost: {
		total: 72,
		lines: [
			{ item: "A4 B&W", quantity: 4, rate: 8, subtotal: 32 },
			{ item: "A4 Color", quantity: 1, rate: 40, subtotal: 40 },
		],
		extra: [],
	},
	files: [
		{ file: { _id: "f1", name: "notes.pdf", numberOfPages: 4 }, settings: { color: false, pageType: "A4", numberOfCopies: 1, sidedness: "none" } },
		{ file: { _id: "f2", name: "cover.pdf", numberOfPages: 1 }, settings: { color: true, pageType: "A4", numberOfCopies: 1, sidedness: "none" } },
	],
	statusHistory: Array.from({ length: 4 }, (_, i) => ({ at: new Date().toISOString(), by: "shop", status: `s${i}` })),
	...extra,
});

test("only the fields the screens use are saved", async () => {
	const job = fullJob("h1");
	job.cost.lines[0]._internal = "x"; // a field no screen reads
	await cache.save("shopA", [job]);
	const [saved] = cache.load("shopA").data;
	assert.equal(saved.shop, undefined);
	assert.equal(saved.statusHistory, undefined);
	assert.equal(saved.cost.lines[0]._internal, undefined);
	assert.deepEqual(saved.createdBy, { _id: "u1", name: "Ali", number: "923001234567" });
	assert.deepEqual(saved.paymentProofFile, { _id: "p1" });
	assert.deepEqual(saved.files[0].file, { _id: "f1", name: "notes.pdf", numberOfPages: 4 });
});

test("optional fields keep their meaning: absent stays absent, null stays null", async () => {
	const noProof = fullJob("h2");
	delete noProof.paymentProofFile;
	await cache.save("shopA", [noProof, fullJob("h3", { paymentProofFile: null, createdBy: "u9" })]);
	const [a, b] = cache.load("shopA").data;
	assert.ok(!("paymentProofFile" in a));
	assert.equal(b.paymentProofFile, null);
	assert.equal(b.createdBy, "u9"); // unpopulated id passes through
});

test("the Dashboard and History screens get the same results from the saved copy", async () => {
	const { computeStats } = await import("../renderer/src/dashboard/statsUtils.js");
	const { transformJob } = await import("../renderer/src/dashboard/jobUtils.js");
	const jobs = [fullJob("h4"), fullJob("h5", { status: "cancelled" })];
	await cache.save("shopA", jobs);
	const saved = cache.load("shopA").data;

	const strip = ({ generatedAt, ...rest }) => rest; // computed "now", differs by call
	assert.deepEqual(strip(computeStats(saved)), strip(computeStats(jobs)));
	// statusHistory is the one field transformJob maps that no screen displays.
	const view = (j) => ({ ...transformJob(j), statusHistory: undefined });
	assert.deepEqual(saved.map(view), jobs.map(view));
});

test("a saved copy is much smaller than the response it came from", async () => {
	const jobs = Array.from({ length: 200 }, (_, i) => fullJob(`h${i}`));
	await cache.save("shopA", jobs);
	const onDisk = fs.statSync(path.join(userData, "history-cache.json")).size;
	const full = Buffer.byteLength(JSON.stringify(jobs));
	assert.ok(onDisk < full * 0.75, `saved ${onDisk} bytes vs ${full} for the full response`);
});

test("a corrupt cache file is treated as no cache", () => {
	fs.writeFileSync(path.join(userData, "history-cache.json"), "{not json");
	assert.equal(cache.load("shopA"), null);
});
