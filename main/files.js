const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { app, protocol, shell, BrowserWindow, dialog } = require("electron");
const { fetchFileBuffer } = require("./api");
const spooler = require("./spooler");

// Job files are downloaded once and cached on disk under userData. Printing
// files are all treated as PDFs (per product spec); a job's optional payment
// proof is an operator-facing image, so it keeps its own type (see below). Both
// are served to the renderer through a dedicated `clickfile://` protocol so
// previews can embed them directly.

const FILE_SCHEME = "clickfile";

// Upper bound on rendering a cached PDF into the offscreen window before we
// spool it. The print engine holds the target printer's spool lock while
// openPrintWindow runs, so this must never be unbounded.
const LOAD_TIMEOUT_MS = 30000;

let _filesDir = null;
function getFilesDir() {
	if (!_filesDir) {
		_filesDir = path.join(app.getPath("userData"), "job-files");
		fs.mkdirSync(_filesDir, { recursive: true });
	}
	return _filesDir;
}

let _proofsDir = null;
function getProofsDir() {
	if (!_proofsDir) {
		_proofsDir = path.join(app.getPath("userData"), "payment-proofs");
		fs.mkdirSync(_proofsDir, { recursive: true });
	}
	return _proofsDir;
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
const _statusListeners = []; // in-process listeners (e.g. the print engine)

function setNotifier(fn) {
	_notify = fn;
}

// In-process subscription to per-file status changes (in addition to the
// renderer notifier). The print engine uses this to re-schedule tasks that
// were waiting on a download.
function addStatusListener(fn) {
	_statusListeners.push(fn);
}

function getStatusMap() {
	return { ..._status };
}

function _setStatus(fileId, status) {
	_status[fileId] = status;
	if (_notify) _notify({ [fileId]: status });
	for (const listener of _statusListeners) {
		try {
			listener(fileId, status);
		} catch (err) {
			console.error("[Files] status listener error:", err);
		}
	}
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
// Payment proofs ride along on the same call (see _syncJobProofs) so a new job
// arrives with everything the operator needs already local.
function syncJobFiles(jobs, onJobFailed) {
	_syncJobProofs(jobs);

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

// ── Payment proofs ────────────────────────────────────────────────────────────
// A job may carry an optional `paymentProofFile` — the id of a screenshot the
// customer uploaded to evidence their transfer. It comes from the same
// /api/files/:fileId endpoint as the printing files, but it is never printed:
// it's only shown to the operator in the job details pane. Two consequences
// shape everything below.
//   1. It is not a PDF, so its type can't be assumed the way localPath does.
//      The bytes are sniffed, the extension is kept on disk, and the protocol
//      handler serves the matching content type.
//   2. It is not required to fulfil the job, so a proof that won't download
//      NEVER fails the job — worst case the operator sees a retry affordance.

// Extension -> content type for everything we're willing to identify. Anything
// else is stored as .bin and served as a download, so the operator can still
// open it in a native app even if the preview can't render it.
const PROOF_CONTENT_TYPES = {
	png: "image/png",
	jpg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	pdf: "application/pdf",
};

// Identifies a proof from its magic bytes, falling back to the server's
// Content-Type header. Returns null when neither is recognised.
function _sniffProofExt(buffer, contentType) {
	const bytes = new Uint8Array(buffer);
	const at = (offset, ...signature) => signature.every((byte, i) => bytes[offset + i] === byte);

	if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "png";
	if (at(0, 0xff, 0xd8, 0xff)) return "jpg";
	if (at(0, 0x47, 0x49, 0x46, 0x38)) return "gif";
	if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
	if (at(0, 0x42, 0x4d)) return "bmp";
	if (at(0, 0x25, 0x50, 0x44, 0x46)) return "pdf";

	const mime = String(contentType || "").split(";")[0].trim().toLowerCase();
	return Object.keys(PROOF_CONTENT_TYPES).find((ext) => PROOF_CONTENT_TYPES[ext] === mime) || null;
}

// fileId -> path on disk. The extension isn't derivable from the id, so a cache
// miss falls back to scanning the directory. In practice every proof downloaded
// this session is in the map; the scan is what makes a leftover file from a
// previous session usable if the startup wipe (clearProofCache) couldn't run.
const _proofPaths = new Map();

function proofPath(fileId) {
	if (!fileId) return null;
	if (_proofPaths.has(fileId)) return _proofPaths.get(fileId);
	let found = null;
	try {
		for (const name of fs.readdirSync(getProofsDir())) {
			if (name.startsWith(`${fileId}.`) && !name.endsWith(".part")) {
				found = path.join(getProofsDir(), name);
				break;
			}
		}
	} catch (error) {
		console.error("[Files] could not scan payment proofs:", error.message);
	}
	if (found) _proofPaths.set(fileId, found);
	return found;
}

function isProofReady(fileId) {
	const target = proofPath(fileId);
	if (!target) return false;
	try {
		return fs.statSync(target).size > 0;
	} catch {
		_proofPaths.delete(fileId); // deleted underneath us — force a re-scan next time
		return false;
	}
}

// Ensures a job's payment proof is on disk, downloading it if needed. Status is
// reported through the same per-file channel as the printing files, so the
// renderer's FilesContext tracks both without knowing the difference.
async function ensureProof(fileId) {
	if (!fileId) return false;

	if (isProofReady(fileId)) {
		if (_status[fileId] !== "ready") _setStatus(fileId, "ready");
		return true;
	}
	if (_inflight.has(fileId)) return true;

	_inflight.add(fileId);
	_setStatus(fileId, "downloading");
	try {
		let attempt = await fetchFileBuffer(fileId);
		if (!attempt.ok || !attempt.buffer) {
			console.warn(`[Files] payment proof ${fileId} failed to download, retrying once…`);
			attempt = await fetchFileBuffer(fileId);
		}
		if (!attempt.ok || !attempt.buffer) throw new Error("download failed");

		const ext = _sniffProofExt(attempt.buffer, attempt.contentType);
		if (!ext) console.warn(`[Files] payment proof ${fileId}: unrecognised type "${attempt.contentType}"`);

		// Same temp-then-rename dance as the printing files so a half-written
		// proof is never served.
		const dest = path.join(getProofsDir(), `${fileId}.${ext || "bin"}`);
		const tmp = `${dest}.part`;
		await fsp.writeFile(tmp, Buffer.from(attempt.buffer));
		await fsp.rename(tmp, dest);
		_proofPaths.set(fileId, dest);
		_setStatus(fileId, "ready");
		console.log(`[Files] downloaded payment proof ${fileId} (${ext || "unknown type"})`);
		return true;
	} catch (error) {
		console.error(`[Files] failed to download payment proof ${fileId} (after retry):`, error.message);
		_setStatus(fileId, "error");
		return false;
	} finally {
		_inflight.delete(fileId);
	}
}

// The proof id off a raw backend job. The field is documented as a file id, but
// tolerate a populated document the way _jobFileIds does.
function _jobProofId(job) {
	const proof = job?.paymentProofFile;
	if (!proof) return null;
	return typeof proof === "string" ? proof : proof._id || null;
}

// jobId -> proof file id, so the proof can be dropped along with the rest of a
// job's cache when it reaches a terminal state (see deleteJobProof).
const _jobProofs = new Map();

// Downloads the payment proof of every job that has one. A proof that errored
// is not retried here — repeated reconciles would hammer a file that isn't
// coming back — but the renderer can ask for another attempt (files:ensure-proof),
// which is what its retry affordance does.
function _syncJobProofs(jobs) {
	const pending = [];
	for (const job of jobs || []) {
		const proofId = _jobProofId(job);
		if (!proofId) continue;
		_jobProofs.set(job._id, proofId);
		if (isProofReady(proofId) || _inflight.has(proofId) || _status[proofId] === "error") continue;
		pending.push(proofId);
	}
	if (pending.length === 0) return;
	_runLimited(pending, 3, ensureProof).catch((err) =>
		console.error("[Files] payment proof sync error:", err)
	);
}

// Drops a job's cached payment proof on the same terminal-state cleanup that
// deletes its printing files.
async function deleteJobProof(jobId) {
	const proofId = _jobProofs.get(jobId);
	if (!proofId) return;
	_jobProofs.delete(jobId);
	const target = proofPath(proofId);
	_proofPaths.delete(proofId);
	delete _status[proofId];
	if (!target) return;
	try {
		await fsp.unlink(target);
		console.log(`[Files] deleted payment proof ${proofId}`);
	} catch (error) {
		if (error.code !== "ENOENT") {
			console.error(`[Files] failed to delete payment proof ${proofId}:`, error.message);
		}
	}
}

// Drops the whole payment-proof cache. Called once at startup: proofs left on
// disk from the previous session are either stale (their job is done) or belong
// to a still-active job, and the first reconcile re-downloads those. Without
// this, a proof re-fetched on demand from History — which has no terminal
// transition left to clean it up — would sit on disk forever.
async function clearProofCache() {
	_proofPaths.clear();
	// Snapshot synchronously so a proof downloaded while the unlinks are in flight
	// can't end up in the list at all; the _proofPaths check below then covers the
	// one remaining case, a fresh download landing on a name we were about to
	// delete.
	let names = [];
	try {
		names = fs.readdirSync(getProofsDir());
	} catch (error) {
		console.error("[Files] could not read payment proof cache:", error.message);
		return;
	}
	let cleared = 0;
	await Promise.all(
		names.map(async (name) => {
			const fileId = name.split(".")[0];
			if (_proofPaths.has(fileId)) return; // re-downloaded already
			try {
				await fsp.unlink(path.join(getProofsDir(), name));
				cleared += 1;
			} catch (error) {
				if (error.code !== "ENOENT") console.error(`[Files] could not clear ${name}:`, error.message);
			}
		})
	);
	if (cleared) console.log(`[Files] cleared ${cleared} cached payment proof(s)`);
}

// Opens a payment proof in the OS default application — the operator's route to
// a full-size, zoomable view of a screenshot the in-app preview shrinks.
async function openProof(fileId) {
	await ensureProof(fileId);
	const target = proofPath(fileId);
	if (!target) throw new Error("payment proof not ready");
	const error = await shell.openPath(target);
	if (error) throw new Error(error);
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

// Loads a cached PDF into an offscreen window, ready to print. The caller owns
// the returned window and must destroy it.
async function openPrintWindow(fileId) {
	await ensureFile(fileId);
	if (!isReady(fileId)) throw new Error("file not ready");

	// `plugins: true` is required so Chromium's PDF viewer actually renders the
	// document — without it the print job comes out blank.
	const win = new BrowserWindow({ show: false, webPreferences: { plugins: true } });
	try {
		// Bound the load: a PDF that makes Chromium's viewer never finish would
		// otherwise hang here forever, and the engine holds this printer's spool
		// lock across the call — every document queued behind it would stall.
		await Promise.race([
			win.loadFile(localPath(fileId)),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error("pdf load timed out")), LOAD_TIMEOUT_MS)
			),
		]);
		// Give the PDF plugin a moment to lay the document out before printing.
		await new Promise((resolve) => setTimeout(resolve, 400));
		return win;
	} catch (err) {
		if (!win.isDestroyed()) win.destroy();
		throw err;
	}
}

// Hands the document to Chromium and resolves with what its print callback
// reports: { ok, reason }. Never rejects and has no timeout of its own, because
// the callback can't be relied on: for a PDF in the viewer plugin Electron often
// doesn't fire it at all while the page prints fine, and only reports
// success=false once the window is destroyed. It is a hint for the spooler
// (see spooler.trackPrintJob), never the verdict.
function startPrint(win, fileId, options) {
	return new Promise((resolve) => {
		try {
			win.webContents.print(options, (success, failureReason) => {
				console.log(`[Files] print callback ${fileId}: success=${success} reason=${failureReason}`);
				resolve({ ok: !!success, reason: failureReason || null });
			});
		} catch (err) {
			resolve({ ok: false, reason: err.message });
		}
	});
}

// The engine's print primitive: hand the document to Chromium silently with its
// own settings applied, then watch the Windows spooler until the job actually
// completes (or dies). The spooler decides the outcome; Chromium's callback only
// matters if the job never shows up in the queue. Throws on any real failure —
// spool refusal, never reaching the queue, queue cancellation, persistent error
// state, or a stuck job — so the caller's failure policy treats them uniformly.
// `onPhase("verifying")` fires once the job is being tracked in the queue.
// `onIdentified(spoolId)` fires as soon as our Windows spool job id is pinned
// down (or null if it never appeared) — the engine releases that printer's
// spool lock there, letting the next document start spooling behind ours.
// Callers must not pass a Print-to-PDF pseudo-printer here (use savePdfCopy).
async function printAndVerify(fileId, settings, deviceName, fileName, { onPhase, onIdentified } = {}) {
	let win;
	try {
		if (!deviceName) throw new Error("no printer specified");
		win = await openPrintWindow(fileId);
	} catch (err) {
		if (onIdentified) onIdentified(null); // nothing spooled — don't hold the lock
		throw err;
	}

	try {
		// Snapshot the queue right before printing so the new job id can be
		// identified. A failed snapshot makes the print untrackable rather than
		// blocking printing altogether.
		const before = await spooler.snapshotPrinter(deviceName);
		const options = buildPrintOptions(settings);
		options.deviceName = deviceName;
		console.log(`[Files] spooling ${fileId} ("${fileName || ""}") → ${deviceName}`, options);

		// Tracking starts the moment the job is handed over, not when the callback
		// fires — the callback may never fire.
		const spool = startPrint(win, fileId, options);
		const result = await spooler.trackPrintJob(deviceName, before, { onPhase, onIdentified, spool });
		if (result.outcome === "aborted") return result; // engine stopped; outcome discarded upstream
		if (result.outcome !== "success") {
			throw new Error(`print ${result.outcome}${result.detail ? `: ${result.detail}` : ""}`);
		}
		return result;
	} finally {
		// Only once there's a verdict: destroying the window while Chromium may
		// still be feeding the spooler could cut the job short.
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
			// URL forms: clickfile://file/<fileId> for a printing file (always a PDF),
			// clickfile://proof/<fileId> for a job's payment proof (type per bytes).
			const url = new URL(request.url);
			const fileId = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
			if (!fileId) return new Response("Not found", { status: 404 });

			let target = null;
			let contentType = "application/pdf";
			if (url.host === "proof") {
				target = isProofReady(fileId) ? proofPath(fileId) : null;
				const ext = target ? path.extname(target).slice(1).toLowerCase() : "";
				contentType = PROOF_CONTENT_TYPES[ext] || "application/octet-stream";
			} else if (isReady(fileId)) {
				target = localPath(fileId);
			}
			if (!target) return new Response("Not found", { status: 404 });

			const data = await fsp.readFile(target);
			return new Response(data, {
				headers: { "Content-Type": contentType, "Cache-Control": "no-cache" },
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
	addStatusListener,
	isReady,
	openFile,
	savePdfCopy,
	printAndVerify,
	deleteJobFiles,
	ensureProof,
	openProof,
	deleteJobProof,
	clearProofCache,
	registerFileSchemePrivileges,
	registerFileProtocol,
};
