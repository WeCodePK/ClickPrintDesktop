const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { app, protocol, shell, BrowserWindow, dialog } = require("electron");
const { fetchFileBuffer } = require("./api");
const store = require("./store");

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

// Ensures a single file is present on disk, downloading it if needed. Retries
// the download once before giving up. Returns true on success, false on failure.
async function ensureFile(fileId) {
	if (!fileId) return false;

	if (isReady(fileId)) {
		if (_status[fileId] !== "ready") _setStatus(fileId, "ready");
		return true;
	}
	// Another caller already owns this download; it will report the outcome, so
	// don't start a second and optimistically assume success here.
	if (_inflight.has(fileId)) return true;

	_inflight.add(fileId);
	_setStatus(fileId, "downloading");
	try {
		let attempt = await fetchFileBuffer(fileId);
		if (!attempt.ok || !attempt.buffer) {
			console.warn(`[Files] download failed for ${fileId}, retrying once…`);
			attempt = await fetchFileBuffer(fileId);
		}
		if (!attempt.ok || !attempt.buffer) throw new Error("download failed");

		// Write to a temp file then rename so a half-written file is never served.
		const dest = localPath(fileId);
		const tmp = `${dest}.part`;
		await fsp.writeFile(tmp, Buffer.from(attempt.buffer));
		await fsp.rename(tmp, dest);
		_setStatus(fileId, "ready");
		console.log(`[Files] downloaded ${fileId}`);
		return true;
	} catch (error) {
		console.error(`[Files] failed to download ${fileId} (after retry):`, error.message);
		_setStatus(fileId, "error");
		return false;
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

// Jobs already flagged failed (a download couldn't be fetched even after a
// retry), so we don't re-download or re-notify on every reconcile.
const _failedJobs = new Set();

function _jobFileIds(job) {
	const ids = [];
	for (const entry of job.files || []) {
		// New job schema nests the document under `entry.file._id`; fall back to the
		// older flat `entry.fileId` shape just in case.
		const fileId = entry.file?._id || entry.fileId;
		if (fileId) ids.push(fileId);
	}
	return ids;
}

// Downloads all of a job's files. If any fail (after their one retry),
// `onJobFailed(jobId)` is invoked so the caller can mark the job "failed" on the
// backend. Only once that succeeds do we finalize (stop retrying + drop the
// partial files) — if it fails we leave everything so the next reconcile retries.
async function _syncOneJob(job, onJobFailed) {
	const jobId = job._id;
	const fileIds = _jobFileIds(job);
	if (fileIds.length === 0) return;

	const results = await Promise.all(fileIds.map((id) => ensureFile(id)));
	if (results.every(Boolean) || _failedJobs.has(jobId)) return;

	console.error(`[Files] job ${jobId} has a failed download → marking failed`);
	let handled = true;
	if (onJobFailed) {
		try {
			handled = await onJobFailed(jobId);
		} catch (err) {
			console.error(`[Files] onJobFailed(${jobId}) error:`, err.message);
			handled = false;
		}
	}
	if (handled) {
		_failedJobs.add(jobId);
		await deleteJobFiles(fileIds); // nothing will be printed; drop partial downloads
	}
}

// Downloads every job's files in the background (bounded concurrency). Safe to
// call repeatedly — cached/in-flight files and already-failed jobs are skipped.
// `onJobFailed(jobId)` fires once per job that has an unrecoverable download.
function syncJobFiles(jobs, onJobFailed) {
	const pending = (jobs || []).filter((j) => !_failedJobs.has(j._id) && _jobFileIds(j).length > 0);
	if (pending.length === 0) return;
	_runLimited(pending, 3, (job) => _syncOneJob(job, onJobFailed)).catch((err) =>
		console.error("[Files] syncJobFiles error:", err)
	);
}

// Removes a cached file from disk and clears its status entry. Best-effort: a
// missing file (already gone / never downloaded) is not an error.
async function deleteFile(fileId) {
	if (!fileId) return;
	try {
		await fsp.unlink(localPath(fileId));
		console.log(`[Files] deleted ${fileId}`);
	} catch (error) {
		if (error.code !== "ENOENT") console.error(`[Files] failed to delete ${fileId}:`, error.message);
	} finally {
		delete _status[fileId];
	}
}

// Deletes every cached file for a job once it reaches a terminal state
// (completed/cancelled). Files aren't previewed or reused anywhere past that
// point (History shows metadata only), so there's no reason to keep them.
async function deleteJobFiles(fileIds) {
	await Promise.all((fileIds || []).map(deleteFile));
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

// Prompts the operator for where to save a PDF, defaulting to Downloads with the
// given suggested name. Returns the chosen path, or null if they cancelled.
// Shared by "printing" to Microsoft Print to PDF and the printer test page.
async function askSavePdfPath(suggestedName) {
	const base = String(suggestedName || "document")
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_") // strip characters Windows filenames forbid
		.replace(/\.pdf$/i, "")
		.trim() || "document";
	const parent = BrowserWindow.getFocusedWindow();
	const options = {
		title: "Save PDF",
		defaultPath: path.join(app.getPath("downloads"), `${base}.pdf`),
		filters: [{ name: "PDF", extensions: ["pdf"] }],
	};
	const { canceled, filePath } = parent
		? await dialog.showSaveDialog(parent, options)
		: await dialog.showSaveDialog(options);
	return canceled || !filePath ? null : filePath;
}

// "Printing" to Microsoft Print to PDF just re-renders a PDF we already have on
// disk — and its webContents.print callback lies (success=false even when the
// file saved fine), which used to need an 8s/30s forgiveness timer. So that
// pseudo-printer is never actually printed to: the operator picks a save
// location and the cached PDF is copied there. The distinct error message on
// cancel lets the renderer show PDF-specific guidance instead of a generic
// print-failed message.
async function savePdfCopy(fileId, fileName) {
	const dest = await askSavePdfPath(fileName || fileId);
	if (!dest) throw new Error("pdf save cancelled");
	await fsp.copyFile(localPath(fileId), dest);
	console.log(`[Files] saved PDF copy ${fileId} → ${dest}`);
}

// Loads a cached PDF into an offscreen window and prints it silently to a
// printer with the document's own settings applied. `deviceName`, when given,
// overrides the operator's saved default for this one job. Resolves once the
// print job is spooled; rejects if printing fails. If the resolved target is
// Microsoft Print to PDF — or nothing was ever selected, which is treated the
// same way — the document is saved via a Save dialog instead of printed.
async function printFile(fileId, settings, deviceName, fileName) {
	await ensureFile(fileId);
	if (!isReady(fileId)) throw new Error("file not ready");

	// Route the job to the explicitly-requested printer, else the operator's
	// saved choice. We never ask Windows what its own default is — if the operator
	// hasn't picked a printer in the app, the app's default is Microsoft Print to
	// PDF, full stop.
	const target = deviceName || store.get("selectedPrinter")?.name || "";

	if (!target || /print to pdf/i.test(target)) {
		await savePdfCopy(fileId, fileName);
		return;
	}

	// `plugins: true` is required so Chromium's PDF viewer actually renders the
	// document — without it the print job comes out blank.
	const win = new BrowserWindow({ show: false, webPreferences: { plugins: true } });
	try {
		await win.loadFile(localPath(fileId));
		// Give the PDF plugin a moment to lay the document out before printing.
		await new Promise((resolve) => setTimeout(resolve, 400));
		const options = buildPrintOptions(settings);
		if (target) options.deviceName = target;
		console.log(`[Files] printing ${fileId} → ${options.deviceName || "default printer"}`, options);

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

			// Guard against a callback that never fires at all — treat the silence as
			// a failure so a stuck/offline printer never falsely advances the status.
			const timer = setTimeout(() => {
				console.log(`[Files] print callback timed out ${fileId}, treating as failed`);
				finish(reject, new Error("print timed out"));
			}, 30000);
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
	askSavePdfPath,
	syncJobFiles,
	getStatusMap,
	setNotifier,
	openFile,
	printFile,
	deleteJobFiles,
	registerFileSchemePrivileges,
	registerFileProtocol,
};
