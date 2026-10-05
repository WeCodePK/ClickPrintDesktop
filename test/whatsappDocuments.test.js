// Files customers send over WhatsApp: picking the document or photo out of a
// Baileys message, naming it so the backend's tus upload accepts it, and the
// reply sent back when the upload fails. uploadFile itself runs against a
// minimal local tus server, with Electron stubbed.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const Module = require("node:module");

const { mediaOf, mediaSize, photoName, uploadName, uploadErrorReply } = require("../main/whatsappDocuments");

test("finds a document, with or without a caption", () => {
	const doc = { fileName: "a.pdf", mimetype: "application/pdf", fileLength: 7 };
	const expected = { kind: "document", fileName: "a.pdf", mimetype: "application/pdf", fileLength: 7 };
	assert.deepEqual(mediaOf({ message: { documentMessage: doc } }), expected);
	assert.deepEqual(mediaOf({ message: { documentWithCaptionMessage: { message: { documentMessage: doc } } } }), expected);
	assert.equal(mediaOf({ message: { conversation: "hi" } }), null);
	assert.equal(mediaOf({ message: { stickerMessage: { mimetype: "image/webp" } } }), null);
	assert.equal(mediaOf({}), null);
});

test("finds a photo and names it by when it was sent", () => {
	const sent = new Date(2026, 9, 1, 14, 30, 12); // local time
	const msg = {
		key: { id: "3EB0C2A1F9D83A5F" },
		messageTimestamp: sent.getTime() / 1000,
		message: { imageMessage: { mimetype: "image/jpeg", fileLength: 1234, caption: "print this" } },
	};
	assert.deepEqual(mediaOf(msg), {
		kind: "photo",
		fileName: "IMG-20261001-143012-3A5F",
		mimetype: "image/jpeg",
		fileLength: 1234,
	});
	assert.equal(uploadName(mediaOf(msg).fileName, "image/jpeg"), "IMG-20261001-143012-3A5F.jpg");
	assert.equal(photoName({ ...msg, messageTimestamp: { toNumber: () => sent.getTime() / 1000 } }), "IMG-20261001-143012-3A5F");
});

test("a photo without a type is taken as JPEG, and view-once photos are skipped", () => {
	assert.equal(mediaOf({ message: { imageMessage: {} } }).mimetype, "image/jpeg");
	assert.equal(mediaOf({ message: { imageMessage: { viewOnce: true } } }), null);
});

test("reads the size from a Long, a number or a string", () => {
	assert.equal(mediaSize({ fileLength: { low: 5, toNumber: () => 5 } }), 5);
	assert.equal(mediaSize({ fileLength: 7 }), 7);
	assert.equal(mediaSize({ fileLength: "9" }), 9);
	assert.equal(mediaSize({}), null);
});

test("names are cleaned to what the backend accepts", () => {
	assert.equal(uploadName("My: report?.docx"), "My_ report_.docx");
	assert.equal(uploadName("notes.txt. "), "notes.txt");
	assert.equal(uploadName("a\u0001b.pdf"), "a_b.pdf");
});

test("a missing extension is filled in from the type", () => {
	assert.equal(uploadName("Thesis", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "Thesis.docx");
	assert.equal(uploadName("", "image/png"), "document.png");
	assert.equal(uploadName(".pdf", "application/pdf"), ".pdf.pdf");
	assert.equal(uploadName("scan", "application/x-unknown"), "scan.pdf");
});

test("long names are cut to 255 characters, keeping the extension", () => {
	const name = uploadName(`${"x".repeat(300)}.pptx`);
	assert.equal(name.length, 255);
	assert.ok(name.endsWith("x.pptx"));
});

test("each upload failure gets a reply the customer can act on", () => {
	assert.match(uploadErrorReply("a.docx", { status: 413 }), /`a\.docx` is too large.*100 MB/);
	assert.match(uploadErrorReply("a.heic", { status: 422 }), /couldn't open `a\.heic`/);
	assert.match(uploadErrorReply("a.pdf", { status: 400 }), /file name/);
	assert.match(uploadErrorReply("a.pdf", { status: 404 }), /interrupted/);
	for (const status of [401, 412, undefined]) {
		assert.match(uploadErrorReply("a.pdf", { status }), /problem on our side/);
	}
	assert.match(uploadErrorReply("a.pdf", { status: 500, message: "disk full" }), /: disk full/);
});

// ── uploadFile over tus ───────────────────────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clickprint-upload-test-"));
let server;
let api;
let failWith = null; // { status, message } to fail the final PATCH with
const seen = []; // { method, auth, metadata }

function stub(file, exports) {
	const mod = new Module(file);
	mod.filename = file;
	mod.loaded = true;
	mod.exports = exports;
	require.cache[file] = mod;
}

before(async () => {
	server = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			seen.push({ method: req.method, auth: req.headers.authorization, metadata: req.headers["upload-metadata"] });
			res.setHeader("Tus-Resumable", "1.0.0");
			if (req.method === "POST") {
				res.writeHead(201, { Location: "/api/files/f1" }).end();
			} else if (req.method === "PATCH" && failWith) {
				res.writeHead(failWith.status, { "Content-Type": "application/json" })
					.end(JSON.stringify({ success: false, message: failWith.message }));
			} else if (req.method === "PATCH") {
				const size = Buffer.concat(chunks).length;
				res.writeHead(200, { "Upload-Offset": String(size), "Content-Type": "application/json" })
					.end(JSON.stringify({ success: true, message: "file uploaded", data: { file: { _id: "f1", size } } }));
			} else {
				res.writeHead(405).end();
			}
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

	stub(require.resolve("electron"), { BrowserWindow: { getAllWindows: () => [] } });
	stub(path.join(__dirname, "..", "main", "state.js"), {
		getAuth: () => ({ token: "jwt" }),
		setAuth() {},
		setJobs() {},
		clearAuth() {},
	});
	stub(path.join(__dirname, "..", "main", "printers.js"), { listPrinters: async () => [] });

	stub(path.join(__dirname, "..", "main", "resourceCache.js"), {
		createResourceCache: () => ({ load: () => null, save: async () => {}, clear: async () => {} }),
		readThrough: (_cache, _shopId, result) => result,
	});
	stub(path.join(__dirname, "..", "main", "historyCache.js"), { load: () => null, save: async () => {}, clear: async () => {} });
	// Requests go to the production host; point them at the local server.
	require("../main/http").setBaseUrl(`http://127.0.0.1:${server.address().port}`);
	api = require("../main/api");
});

after(() => {
	server.close();
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("uploadFile sends the file with the JWT and filename and returns the File", async () => {
	const file = path.join(tmp, "notes.docx");
	fs.writeFileSync(file, "hello world");
	failWith = null;
	seen.length = 0;

	const result = await api.uploadFile(file, { filename: "notes.docx", filetype: "application/msword" });
	assert.deepEqual(result, { success: true, data: { _id: "f1", size: 11 } });
	assert.ok(seen.every((r) => r.auth === "Bearer jwt"));
	assert.match(seen[0].metadata, new RegExp(`filename ${Buffer.from("notes.docx").toString("base64")}`));
});

test("uploadFile reports the backend's status and message on failure", async () => {
	const file = path.join(tmp, "photo.heic");
	fs.writeFileSync(file, "not really heic");
	failWith = { status: 422, message: "file conversion failed" };

	const result = await api.uploadFile(file, { filename: "photo.heic" });
	assert.deepEqual(result, { success: false, status: 422, message: "file conversion failed" });
});
