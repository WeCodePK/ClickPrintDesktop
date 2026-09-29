// Documents customers send over WhatsApp: picking the document out of a Baileys
// message, naming it so the backend's tus upload accepts it, and the reply sent
// back when the upload fails. uploadFile itself runs against a minimal local tus
// server, with Electron stubbed.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const Module = require("node:module");

const { documentOf, documentSize, uploadName, uploadErrorReply } = require("../main/whatsappDocuments");

test("finds a document, with or without a caption", () => {
	const doc = { fileName: "a.pdf" };
	assert.equal(documentOf({ message: { documentMessage: doc } }), doc);
	assert.equal(documentOf({ message: { documentWithCaptionMessage: { message: { documentMessage: doc } } } }), doc);
	assert.equal(documentOf({ message: { conversation: "hi" } }), null);
	assert.equal(documentOf({}), null);
});

test("reads the size from a Long, a number or a string", () => {
	assert.equal(documentSize({ fileLength: { low: 5, toNumber: () => 5 } }), 5);
	assert.equal(documentSize({ fileLength: 7 }), 7);
	assert.equal(documentSize({ fileLength: "9" }), 9);
	assert.equal(documentSize({}), null);
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

	// api.js hardcodes the production host; point it at the local server.
	const source = fs
		.readFileSync(path.join(__dirname, "..", "main", "api.js"), "utf8")
		.replace(/const API_BASE_URL = "[^"]*"/, `const API_BASE_URL = "http://127.0.0.1:${server.address().port}"`);
	const mod = new Module(path.join(__dirname, "..", "main", "api.js"), module);
	mod.filename = path.join(__dirname, "..", "main", "api.js");
	mod.paths = Module._nodeModulePaths(path.dirname(mod.filename));
	mod._compile(source, mod.filename);
	api = mod.exports;
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
