// Downloads on a link that keeps dropping (main/files.js): a failed download
// is retried — never failing its job — a permanent "no" leaves the file
// unavailable for the operator, a body cut off mid-way never passes for the
// file, and the next attempt resumes it with a Range request. Runs the real
// module against a temp directory, with Electron and the backend stubbed.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const MAIN = path.join(__dirname, "..", "main");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "clickprint-retry-test-"));
// fileId -> { mode, body }: "offline" | "missing" | "ok" | "cut" (sends only
// half the body the first time, honours Range afterwards)
const remote = new Map();
const requests = [];
let files;

function stub(file, exports) {
	const mod = new Module(file);
	mod.filename = file;
	mod.loaded = true;
	mod.exports = exports;
	require.cache[file] = mod;
}

const OFFLINE = { ok: false, kind: "network", offline: true, retryable: true };

before(() => {
	stub(require.resolve("electron"), { app: { getPath: () => userData }, protocol: {}, shell: {}, BrowserWindow: {} });
	stub(path.join(MAIN, "api.js"), {
		openFileDownload: async (fileId, { accept, range } = {}) => {
			requests.push({ fileId, accept, range: range ?? null });
			if (accept !== "application/pdf") return { ok: false, kind: "http", status: 404 }; // no raw uploads here
			const entry = remote.get(fileId);
			if (!entry || entry.mode === "offline") return OFFLINE;
			if (entry.mode === "missing") return { ok: false, kind: "http", status: 404 };
			const controller = new AbortController();
			if (entry.mode === "cut" && !entry.cutDone) {
				entry.cutDone = true;
				// Promises the whole file, delivers half, then the link "drops".
				const half = entry.body.subarray(0, entry.body.length / 2);
				const body = new ReadableStream({
					start(c) {
						c.enqueue(half);
						c.close();
					},
				});
				return { ok: true, status: 200, controller, response: new Response(body, { headers: { "content-length": String(entry.body.length) } }) };
			}
			if (range) {
				const rest = entry.body.subarray(range);
				return { ok: true, status: 206, controller, response: new Response(rest, { headers: { "content-length": String(rest.length) } }) };
			}
			return { ok: true, status: 200, controller, response: new Response(entry.body, { headers: { "content-length": String(entry.body.length) } }) };
		},
	});
	stub(path.join(MAIN, "spooler.js"), {});
	files = require(path.join(MAIN, "files.js"));
});

after(() => fs.rmSync(userData, { recursive: true, force: true }));

const job = (id, fileId) => ({ _id: id, files: [{ file: { _id: fileId, name: `${fileId}.pdf` } }] });
const status = (fileId) => files.getStatusMap()[fileId];
const onDisk = (jobId, fileId) => fs.readFileSync(path.join(userData, "job-files", jobId, `1 - ${fileId}.pdf`), "utf8");

test("a download that fails offline waits to retry, then lands when the connection is back", async () => {
	remote.set("f1", { mode: "offline", body: Buffer.from("%PDF-one") });
	await files.syncJobFiles([job("j1", "f1")]);
	assert.equal(status("f1"), "retrying");
	assert.equal(files.isReady("f1"), false);

	// Reconciles while it waits don't hammer the backend.
	const before = requests.length;
	await files.syncJobFiles([job("j1", "f1")]);
	assert.equal(requests.length, before);

	remote.get("f1").mode = "ok";
	files.retryAll();
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(status("f1"), "ready");
	assert.equal(onDisk("j1", "f1"), "%PDF-one");
});

test("a file the backend says doesn't exist is unavailable — and only the operator retries it", async () => {
	remote.set("f2", { mode: "missing" });
	await files.syncJobFiles([job("j2", "f2")]);
	assert.equal(status("f2"), "unavailable");

	const before = requests.length;
	files.retryAll();
	await files.syncJobFiles([job("j2", "f2")]);
	assert.equal(requests.length, before, "not retried automatically");

	remote.set("f2", { mode: "ok", body: Buffer.from("%PDF-two") });
	assert.equal(await files.redownloadFile("f2"), true);
	assert.equal(status("f2"), "ready");
});

test("a body cut off mid-way never passes for the file, and the retry resumes it", async () => {
	const body = Buffer.from("%PDF-0123456789abcde");
	remote.set("f3", { mode: "cut", body });
	await files.syncJobFiles([job("j3", "f3")]);
	assert.equal(status("f3"), "retrying");
	assert.equal(files.isReady("f3"), false, "the half file is not served");
	assert.ok(fs.existsSync(path.join(userData, "job-files", "j3", "1 - f3.pdf.part")), "the partial copy is kept");

	files.retryAll();
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(status("f3"), "ready");
	assert.equal(onDisk("j3", "f3"), body.toString());
	const last = requests.filter((r) => r.fileId === "f3").at(-1);
	assert.equal(last.range, body.length / 2, "resumed from where it stopped");
});

test("syncJobFiles has no way to fail a job any more", () => {
	assert.equal(files.syncJobFiles.length, 1, "takes only the jobs");
});
