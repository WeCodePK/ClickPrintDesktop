// The job-file cache (main/files.js): first download, and the preview's Reload —
// a re-download that replaces a cached copy without ever losing it. Runs the real
// module against a temp directory, with Electron and the backend stubbed.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const MAIN = path.join(__dirname, "..", "main");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "clickprint-files-test-"));
const remote = new Map(); // fileId -> bytes the "backend" serves; absent = download fails
const statuses = [];
let files;

function stub(file, exports) {
	const mod = new Module(file);
	mod.filename = file;
	mod.loaded = true;
	mod.exports = exports;
	require.cache[file] = mod;
}

before(() => {
	stub(require.resolve("electron"), {
		app: { getPath: () => userData },
		protocol: {},
		shell: {},
		BrowserWindow: {},
		dialog: {},
	});
	stub(path.join(MAIN, "api.js"), {
		fetchFileBuffer: async (fileId) =>
			remote.has(fileId) ? { ok: true, buffer: remote.get(fileId) } : { ok: false, buffer: null },
	});
	stub(path.join(MAIN, "spooler.js"), {});
	files = require(path.join(MAIN, "files.js"));
	files.setNotifier((update) => statuses.push(update));
});

after(() => fs.rmSync(userData, { recursive: true, force: true }));

const cached = (fileId) => fs.readFileSync(path.join(userData, "job-files", `${fileId}.pdf`), "utf8");

test("a file is downloaded once into the cache", async () => {
	remote.set("f1", Buffer.from("%PDF-original"));
	assert.equal(files.isReady("f1"), false);
	await files.syncJobFiles([{ _id: "j1", files: [{ file: { _id: "f1" } }] }]);
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(files.isReady("f1"), true);
	assert.equal(cached("f1"), "%PDF-original");
});

test("Reload replaces the cached copy with a fresh download", async () => {
	remote.set("f1", Buffer.from("%PDF-fresh"));
	statuses.length = 0;
	assert.equal(await files.redownloadFile("f1"), true);
	assert.equal(cached("f1"), "%PDF-fresh");
	assert.deepEqual(statuses, [{ f1: "downloading" }, { f1: "ready" }]);
	assert.ok(!fs.existsSync(path.join(userData, "job-files", "f1.pdf.part")), "no temp file left behind");
});

test("a failed Reload keeps the copy that was cached", async () => {
	remote.delete("f1"); // backend now refuses
	statuses.length = 0;
	assert.equal(await files.redownloadFile("f1"), false);
	assert.equal(cached("f1"), "%PDF-fresh");
	assert.deepEqual(statuses, [{ f1: "downloading" }, { f1: "ready" }]);
});

test("a failed Reload of a file that was never cached reports an error", async () => {
	statuses.length = 0;
	assert.equal(await files.redownloadFile("missing"), false);
	assert.equal(files.isReady("missing"), false);
	assert.deepEqual(statuses, [{ missing: "downloading" }, { missing: "error" }]);
});
