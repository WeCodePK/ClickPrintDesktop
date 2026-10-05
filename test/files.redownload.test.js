// The job-file cache (main/files.js): first download into the job's folder, the
// preview's Reload — a re-download that replaces a cached copy without ever
// losing it — and dropping the folder when the job ends. Runs the real
// module against a temp directory, with Electron and the backend stubbed.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const MAIN = path.join(__dirname, "..", "main");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "clickprint-files-test-"));
const remote = new Map(); // fileId -> PDF rendition the "backend" serves; absent = download fails
const rawRemote = new Map(); // fileId -> the raw upload, served when no Accept header is sent
const requests = []; // { fileId, accept } per fetch
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
		// The download as api.openFileDownload opens it: a Response to stream, or
		// the backend's refusal (404) when it doesn't have the file.
		openFileDownload: async (fileId, { accept } = {}) => {
			requests.push({ fileId, accept });
			const source = accept === "application/pdf" ? remote : rawRemote;
			if (!source.has(fileId)) return { ok: false, kind: "http", status: 404, offline: false, retryable: false };
			const body = source.get(fileId);
			return { ok: true, status: 200, response: new Response(body, { headers: { "content-length": String(body.length) } }), controller: new AbortController() };
		},
	});
	stub(path.join(MAIN, "spooler.js"), {});
	files = require(path.join(MAIN, "files.js"));
	files.setNotifier((update) => statuses.push(update));
});

after(() => fs.rmSync(userData, { recursive: true, force: true }));

const jobDir = path.join(userData, "job-files", "j1");
const cached = () => fs.readFileSync(path.join(jobDir, "1 - report.pdf"), "utf8");

test("a document is downloaded into its job's folder, as its PDF rendition and its raw upload", async () => {
	remote.set("f1", Buffer.from("%PDF-original"));
	rawRemote.set("f1", Buffer.from("raw-docx"));
	assert.equal(files.isReady("f1"), false);
	await files.syncJobFiles([{ _id: "j1", files: [{ file: { _id: "f1", name: "report.docx" } }] }]);
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(files.isReady("f1"), true);
	assert.equal(cached(), "%PDF-original");
	assert.equal(fs.readFileSync(path.join(jobDir, "1 - report.docx"), "utf8"), "raw-docx");
	assert.deepEqual(requests.filter((r) => r.fileId === "f1").map((r) => r.accept), ["application/pdf", undefined]);
});

test("Reload replaces the cached copy with a fresh download", async () => {
	remote.set("f1", Buffer.from("%PDF-fresh"));
	statuses.length = 0;
	assert.equal(await files.redownloadFile("f1"), true);
	assert.equal(cached(), "%PDF-fresh");
	assert.deepEqual(statuses, [{ f1: "downloading" }, { f1: "ready" }]);
	assert.ok(!fs.existsSync(path.join(jobDir, "1 - report.pdf.part")), "no temp file left behind");
});

test("a failed Reload keeps the copy that was cached", async () => {
	remote.delete("f1"); // backend now refuses
	statuses.length = 0;
	assert.equal(await files.redownloadFile("f1"), false);
	assert.equal(cached(), "%PDF-fresh");
	assert.deepEqual(statuses, [{ f1: "downloading" }, { f1: "ready" }]);
});

test("a failed Reload of a file that was never cached reports it unavailable", async () => {
	statuses.length = 0;
	assert.equal(await files.redownloadFile("missing"), false);
	assert.equal(files.isReady("missing"), false);
	assert.deepEqual(statuses, [{ missing: "downloading" }, { missing: "unavailable" }]);
});

test("a raw upload that won't download doesn't fail the document", async () => {
	remote.set("f2", Buffer.from("%PDF-two"));
	statuses.length = 0;
	await files.syncJobFiles([{ _id: "j2", files: [{ file: { _id: "f2", name: "notes.txt" } }] }]);
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(files.isReady("f2"), true);
	assert.deepEqual(fs.readdirSync(path.join(userData, "job-files", "j2")), ["1 - notes.pdf"]);
});

test("the original upload is offered for opening only when it was saved", () => {
	assert.deepEqual(files.getRawFileInfo("f1"), { name: "1 - report.docx", ext: "docx" });
	assert.equal(files.getRawFileInfo("f2"), null); // its raw download failed
});

test("ending a job deletes its folder", async () => {
	await files.deleteJobFiles("j2", ["f2"]);
	assert.equal(fs.existsSync(path.join(userData, "job-files", "j2")), false);
	assert.equal(files.isReady("f2"), false);
});

test("single-sided and pages-per-sheet settings reach the printer", () => {
	const single = files.buildPrintOptions({ sidedness: "none", pagesPerSheet: 4 });
	assert.equal(single.duplexMode, "simplex"); // was left to the printer's default
	assert.equal(single.pagesPerSheet, 4);
	assert.equal(files.buildPrintOptions({ sidedness: "long", pagesPerSheet: 1 }).pagesPerSheet, undefined);
});
