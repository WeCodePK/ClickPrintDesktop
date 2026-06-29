const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { app, protocol, shell, BrowserWindow } = require("electron");
const { fetchFileBuffer } = require("./api");

// Job files are downloaded once and cached on disk under userData. All files are
// treated as PDFs (per product spec) and served to the renderer through a
// dedicated `clickfile://` protocol so previews can embed them directly.

const FILE_SCHEME = "clickfile";

let _filesDir = null;
function getFilesDir() {
	if (!_filesDir) {
		_filesDir = path.join(app.getPath("userData"), "job-files");
		fs.mkdirSync(_filesDir, { recursive: true });
	}
	return _filesDir;
}

function localPath(fileId) {
	return path.join(getFilesDir(), `${fileId}.pdf`);
}

function isReady(fileId) {
	try {
		return fs.statSync(localPath(fileId)).size > 0;
	} catch {
		return false;
	}
}

// fileId -> "downloading" | "ready" | "error"
const _status = {};
const _inflight = new Set();
let _notify = null; // (updates: {fileId: status}) => void

function setNotifier(fn) {
	_notify = fn;
}

function getStatusMap() {
	return { ..._status };
}

function _setStatus(fileId, status) {
	_status[fileId] = status;
	if (_notify) _notify({ [fileId]: status });
}

// Ensures a single file is present on disk, downloading it if needed.
async function ensureFile(fileId) {
	if (!fileId) return;

	if (isReady(fileId)) {
		if (_status[fileId] !== "ready") _setStatus(fileId, "ready");
		return;
	}
	if (_inflight.has(fileId)) return;

	_inflight.add(fileId);
	_setStatus(fileId, "downloading");
	try {
		const { ok, buffer } = await fetchFileBuffer(fileId);
		if (!ok || !buffer) throw new Error("download failed");

		// Write to a temp file then rename so a half-written file is never served.
		const dest = localPath(fileId);
		const tmp = `${dest}.part`;
		await fsp.writeFile(tmp, Buffer.from(buffer));
		await fsp.rename(tmp, dest);
		_setStatus(fileId, "ready");
		console.log(`[Files] downloaded ${fileId}`);
	} catch (error) {
		console.error(`[Files] failed to download ${fileId}:`, error.message);
		_setStatus(fileId, "error");
	} finally {
		_inflight.delete(fileId);
	}
}

// Runs an async worker over items with bounded concurrency.
async function _runLimited(items, limit, worker) {
	const queue = [...items];
	const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
		while (queue.length) {
			await worker(queue.shift());
		}
	});
	await Promise.all(runners);
}

// Collects every fileId referenced by the given jobs and downloads any that are
// missing, in the background. Safe to call repeatedly (already-cached files and
// in-flight downloads are skipped).
function syncJobFiles(jobs) {
	const ids = new Set();
	for (const job of jobs || []) {
		for (const file of job.files || []) {
			if (file.fileId) ids.add(file.fileId);
		}
	}
	if (ids.size === 0) return;
	_runLimited([...ids], 4, ensureFile).catch((err) =>
		console.error("[Files] syncJobFiles error:", err)
	);
}

// Opens a cached file in the OS default application (e.g. the system PDF viewer).
async function openFile(fileId) {
	await ensureFile(fileId);
	if (!isReady(fileId)) throw new Error("file not ready");
	const error = await shell.openPath(localPath(fileId));
	if (error) throw new Error(error);
}

// Parses a human page range like "1-3,5" into Electron's 0-based {from,to} list.
// Returns null for "all pages" / empty input so the whole document prints.
function parsePageRanges(selection) {
	if (!selection || /all/i.test(selection)) return null;
	const ranges = [];
	for (const part of String(selection).split(",")) {
		const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
		if (!match) continue;
		const from = parseInt(match[1], 10) - 1;
		const to = match[2] ? parseInt(match[2], 10) - 1 : from;
		if (from >= 0 && to >= from) ranges.push({ from, to });
	}
	return ranges.length ? ranges : null;
}

// Electron's webContents.print only accepts these named page sizes (anything
// else must be passed as a {width,height} object, so we just drop unknowns and
// let the printer default decide).
const VALID_PAGE_SIZES = new Set(["A0", "A1", "A2", "A3", "A4", "A5", "A6", "Legal", "Letter", "Tabloid"]);

// Maps a file's print settings onto Electron's webContents.print options. Used
// for silent printing, so every option here is applied directly to the job.
function buildPrintOptions(settings = {}) {
	const options = { silent: true, printBackground: true };

	if (typeof settings.color === "boolean") options.color = settings.color;
	if (settings.numberOfCopies) options.copies = settings.numberOfCopies;
	if (settings.orientation) options.landscape = settings.orientation === "landscape";
	if (settings.pageType && VALID_PAGE_SIZES.has(settings.pageType)) options.pageSize = settings.pageType;

	const duplex = { single: "simplex", long: "longEdge", short: "shortEdge", double: "longEdge" }[settings.sidedness];
	if (duplex) options.duplexMode = duplex;

	const ranges = parsePageRanges(settings.pageSelection);
	if (ranges) options.pageRanges = ranges;

	return options;
}

// Loads a cached PDF into an offscreen window and prints it silently to the
// default printer with the document's own settings applied. Resolves once the
// print job is spooled; rejects if printing fails.
async function printFile(fileId, settings) {
	await ensureFile(fileId);
	if (!isReady(fileId)) throw new Error("file not ready");

	// `plugins: true` is required so Chromium's PDF viewer actually renders the
	// document — without it the print job comes out blank.
	const win = new BrowserWindow({ show: false, webPreferences: { plugins: true } });
	try {
		await win.loadFile(localPath(fileId));
		// Give the PDF plugin a moment to lay the document out before printing.
		await new Promise((resolve) => setTimeout(resolve, 400));
		const options = buildPrintOptions(settings);
		console.log(`[Files] printing ${fileId} →`, options);
		await new Promise((resolve, reject) => {
			let settled = false;
			const finish = (fn, arg) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				fn(arg);
			};

			win.webContents.print(options, (success, failureReason) => {
				console.log(`[Files] print callback ${fileId}: success=${success} reason=${failureReason}`);
				if (success) finish(resolve);
				else finish(reject, new Error(failureReason || "print failed"));
			});

			// Safety net: some printers (notably "Microsoft Print to PDF") never
			// invoke the completion callback. The print() call above didn't throw, so
			// the job was dispatched — assume it spooled so the status can advance.
			const timer = setTimeout(() => {
				console.log(`[Files] print callback timed out ${fileId}, assuming spooled`);
				finish(resolve);
			}, 8000);
		});
		console.log(`[Files] print spooled ${fileId}`);
	} finally {
		if (!win.isDestroyed()) win.destroy();
	}
}

// Registers the privileged scheme. Must be called before app `ready`.
function registerFileSchemePrivileges() {
	protocol.registerSchemesAsPrivileged([
		{
			scheme: FILE_SCHEME,
			privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
		},
	]);
}

// Wires the protocol handler that serves cached files. Call after app `ready`.
function registerFileProtocol() {
	protocol.handle(FILE_SCHEME, async (request) => {
		try {
			// URL form: clickfile://file/<fileId>
			const url = new URL(request.url);
			const fileId = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
			if (!fileId || !isReady(fileId)) {
				return new Response("Not found", { status: 404 });
			}
			const data = await fsp.readFile(localPath(fileId));
			return new Response(data, {
				headers: { "Content-Type": "application/pdf", "Cache-Control": "no-cache" },
			});
		} catch (error) {
			console.error("[Files] protocol error:", error.message);
			return new Response("Error", { status: 500 });
		}
	});
}

module.exports = {
	FILE_SCHEME,
	syncJobFiles,
	getStatusMap,
	setNotifier,
	openFile,
	printFile,
	registerFileSchemePrivileges,
	registerFileProtocol,
};
