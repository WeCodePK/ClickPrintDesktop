const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { app, protocol, shell, BrowserWindow } = require("electron");
const { openFileDownload } = require("./api");
const spooler = require("./spooler");

// Job files are downloaded once and cached on disk under userData, one folder
// per job named after the job's id (job-files/<jobId>/), so the operator can open
// a job's folder in Explorer and find everything in it. Each document is stored
// twice: the customer's raw upload, and the backend's PDF rendition of it — the
// PDF is what gets previewed and printed. A job's optional payment proof is an
// operator-facing image, so it keeps its own type (see below). Files are served to
// the renderer through a dedicated `clickfile://` protocol so previews can embed
// them directly.

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

// Strips characters Windows forbids in file and folder names.
function _safeName(name) {
	return String(name || "")
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
		.replace(/[. ]+$/, "") // Windows also refuses trailing dots and spaces
		.trim();
}

function jobDir(jobId) {
	return path.join(getFilesDir(), _safeName(jobId) || "unknown-job");
}

// fileId -> { jobId, pdfName, rawName }, learned from the jobs list (see
// _registerJobFiles). The on-disk location of a document depends on its job and
// its name, neither of which is derivable from the file id alone.
const _fileMeta = new Map();

// Extension for a raw upload whose name doesn't carry one, from the type the
// backend reports for it.
const RAW_EXTENSIONS = {
	"application/pdf": "pdf",
	"application/msword": "doc",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
	"application/vnd.ms-powerpoint": "ppt",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
	"application/vnd.ms-excel": "xls",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
	"text/plain": "txt",
	"image/png": "png",
	"image/jpeg": "jpg",
};

// On-disk names for the Nth document of a job: "1 - report.docx" beside
// "1 - report.pdf". The number matches "Document (1)" in the UI and keeps two
// uploads with the same name apart. A raw upload that is already a PDF has no
// separate raw copy (rawName null) — the PDF rendition stands for both.
function _documentNames(index, name) {
	const safe = _safeName(name) || `Document ${index + 1}`;
	const ext = path.extname(safe);
	const base = ext ? safe.slice(0, -ext.length) : safe;
	const prefix = `${index + 1} - `;
	return {
		pdfName: `${prefix}${base}.pdf`,
		rawName: ext.toLowerCase() === ".pdf" ? null : `${prefix}${safe}`,
		rawHasExt: !!ext,
	};
}

function _registerJobFiles(job) {
	(job.files || []).forEach((entry, index) => {
		const fileId = entry.file?._id || entry.fileId;
		if (!fileId) return;
		const name = entry.file?.name || entry.name || entry.fileName;
		_fileMeta.set(fileId, { jobId: job._id, ..._documentNames(index, name) });
	});
}

// Path of a document's PDF rendition, or null for a file whose job hasn't been
// seen yet.
function localPath(fileId) {
	const meta = _fileMeta.get(fileId);
	return meta ? path.join(jobDir(meta.jobId), meta.pdfName) : null;
}

function isReady(fileId) {
	const target = localPath(fileId);
	if (!target) return false;
	try {
		return fs.statSync(target).size > 0;
	} catch {
		return false;
	}
}

// ── Downloading ───────────────────────────────────────────────────────────────
// Built for a link that drops out for minutes at a time:
//   - a download streams to "<name>.part" and only an intact file is renamed
//     into place, so a half-written copy is never served;
//   - it is cut off only when no bytes arrive for IDLE_TIMEOUT_MS (a large file
//     on a slow link still finishes), and the next attempt resumes from the
//     .part with a Range request when the server supports it;
//   - a failure that could clear up (offline, timeout, 5xx, 401) is retried on
//     a backoff, forever, and at once when the connection returns (retryAll) —
//     it NEVER fails the job. Only a permanent answer (404, 403, 410, …) stops
//     retrying; the file is then "unavailable" and the operator decides.

const IDLE_TIMEOUT_MS = 30000;
const RETRY_MIN_MS = 5000;
const RETRY_MAX_MS = 2 * 60 * 1000;
const PDF_CONCURRENCY = 3;

// fileId -> "downloading" | "ready" | "retrying" | "unavailable"
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
	if (_status[fileId] === status) return;
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

// A failed download's verdict: a permanent no, or worth retrying.
function _isPermanent(failure) {
	return failure?.kind === "http" && ![408, 429].includes(failure.status);
}

// key ("pdf:<id>", "raw:<id>", "proof:<id>") -> { attempt, timer, run }
const _retries = new Map();

function _scheduleRetry(key, run) {
	const entry = _retries.get(key) || { attempt: 0, timer: null, run };
	entry.run = run;
	entry.attempt += 1;
	clearTimeout(entry.timer);
	const ceiling = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** (entry.attempt - 1));
	const delay = Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
	entry.timer = setTimeout(() => {
		entry.timer = null;
		run();
	}, delay);
	entry.timer.unref?.();
	_retries.set(key, entry);
	console.log(`[Files] ${key} retry #${entry.attempt} in ${Math.round(delay / 1000)}s`);
}

function _clearRetry(key) {
	const entry = _retries.get(key);
	if (!entry) return;
	clearTimeout(entry.timer);
	_retries.delete(key);
}

const _waitingRetry = (key) => !!_retries.get(key)?.timer;

// The connection is back: every waiting download goes now instead of at the
// end of its backoff.
function retryAll() {
	const waiting = [..._retries.values()].filter((entry) => entry.timer);
	if (waiting.length) console.log(`[Files] connection back — retrying ${waiting.length} download(s)`);
	for (const entry of waiting) {
		clearTimeout(entry.timer);
		entry.timer = null;
		entry.run();
	}
	_pumpRaw();
}

// The download primitive — api.openFileDownload, behind a function so a failed
// call can never throw past the retry logic.
async function _openDownload(fileId, opts) {
	try {
		return await openFileDownload(fileId, opts);
	} catch (error) {
		console.error(`[Files] download of ${fileId} failed to start:`, error.message);
		return { ok: false, kind: "network", offline: true, retryable: true };
	}
}

const INTERRUPTED = { ok: false, kind: "network", offline: true, retryable: true };

// Streams one file from the backend into `part`, resuming from what's already
// there when the server honours Range. Resolves { ok: true, contentType } with
// the whole file in `part`, or a failure ({ ok: false, kind, status, … }).
// `fresh` discards any partial copy first.
async function _streamToPart(fileId, part, { accept, fresh = false } = {}) {
	await fsp.mkdir(path.dirname(part), { recursive: true });
	if (fresh) await fsp.rm(part, { force: true });
	let offset = 0;
	try {
		offset = (await fsp.stat(part)).size;
	} catch {}

	let res = await _openDownload(fileId, { accept, range: offset || undefined });
	if (!res.ok && res.status === 416) {
		// The partial copy doesn't match the file any more — start over.
		await fsp.rm(part, { force: true });
		offset = 0;
		res = await _openDownload(fileId, { accept });
	}
	if (!res.ok) return res;

	const headers = res.response.headers;
	const encoding = headers.get("content-encoding");
	const encoded = !!encoding && encoding !== "identity";
	const append = offset > 0 && res.status === 206 && !encoded;
	const start = append ? offset : 0;

	const handle = await fsp.open(part, append ? "a" : "w");
	let idle = null;
	const arm = () => {
		clearTimeout(idle);
		idle = setTimeout(() => res.controller?.abort(new Error("download stalled")), IDLE_TIMEOUT_MS);
	};
	try {
		arm();
		for await (const chunk of res.response.body) {
			arm();
			await handle.write(chunk);
		}
	} catch (error) {
		console.warn(`[Files] ${fileId} download interrupted:`, error.message);
		return INTERRUPTED;
	} finally {
		clearTimeout(idle);
		await handle.close();
	}

	// A body that ended early (the link dropped) must not pass for the file.
	const length = Number(headers.get("content-length"));
	if (!encoded && Number.isFinite(length) && length > 0) {
		const size = (await fsp.stat(part)).size;
		if (size !== start + length) {
			console.warn(`[Files] ${fileId} download truncated (${size} of ${start + length} bytes)`);
			return INTERRUPTED;
		}
	}
	return { ok: true, contentType: headers.get("content-type") };
}

// Downloads a document's PDF rendition — what gets previewed and printed —
// into its job folder. Resolves { ok } or a failure.
async function _downloadPdf(fileId, { fresh = false } = {}) {
	const meta = _fileMeta.get(fileId);
	if (!meta) return { ok: false, kind: "http", status: 404, message: "file does not belong to a known job" };
	const dest = path.join(jobDir(meta.jobId), meta.pdfName);
	const part = `${dest}.part`;
	const result = await _streamToPart(fileId, part, { accept: "application/pdf", fresh });
	if (!result.ok) return result;
	await fsp.rename(part, dest);
	return { ok: true };
}

// ── Raw uploads (optional; after every PDF) ──
// The customer's original upload is only there for the operator to open from
// Explorer, so it never competes with the PDFs that printing waits on: raw
// downloads run one at a time, only while no PDF is downloading, and a failure
// is retried quietly (or dropped, when permanent) without touching the
// document's status.

const _rawQueue = [];
let _rawBusy = false;

function _queueRaw(fileId) {
	const meta = _fileMeta.get(fileId);
	if (!meta?.rawName || rawPath(fileId) || _rawQueue.includes(fileId) || _waitingRetry(`raw:${fileId}`)) return;
	_rawQueue.push(fileId);
	_pumpRaw();
}

async function _pumpRaw() {
	if (_rawBusy) return;
	_rawBusy = true;
	try {
		while (_rawQueue.length && _inflight.size === 0) {
			await _downloadRaw(_rawQueue.shift());
		}
	} finally {
		_rawBusy = false;
	}
}

async function _downloadRaw(fileId) {
	const meta = _fileMeta.get(fileId);
	if (!meta?.rawName) return;
	const dir = jobDir(meta.jobId);
	const part = path.join(dir, `${meta.rawName}.part`);
	try {
		const result = await _streamToPart(fileId, part, {});
		if (!result.ok) {
			if (_isPermanent(result)) {
				console.warn(`[Files] the raw upload of ${fileId} isn't available (HTTP ${result.status}) — skipping it`);
				_clearRetry(`raw:${fileId}`);
			} else if (_fileMeta.has(fileId)) {
				_scheduleRetry(`raw:${fileId}`, () => _queueRaw(fileId));
			}
			return;
		}
		_clearRetry(`raw:${fileId}`);
		const mime = String(result.contentType || "").split(";")[0].trim().toLowerCase();
		// A name without an extension takes one from the reported type. A raw upload
		// that turns out to be a PDF is already covered by the rendition.
		const ext = meta.rawHasExt ? "" : RAW_EXTENSIONS[mime];
		if (ext === "pdf" || !_fileMeta.has(fileId)) {
			await fsp.rm(part, { force: true });
			return;
		}
		await fsp.rename(part, path.join(dir, ext ? `${meta.rawName}.${ext}` : meta.rawName));
	} catch (error) {
		console.warn(`[Files] could not save the raw upload of ${fileId}:`, error.message);
	}
}

// Ensures a document's PDF is on disk, downloading it now if needed. Resolves
// true when it's ready. A failure leaves it "retrying" (with a retry
// scheduled) or "unavailable" — it never fails the job.
async function ensureFile(fileId, { fresh = false } = {}) {
	if (!fileId) return false;

	if (!fresh && isReady(fileId)) {
		_setStatus(fileId, "ready");
		_queueRaw(fileId);
		return true;
	}
	if (_inflight.has(fileId)) return false; // its owner reports the outcome

	_inflight.add(fileId);
	_clearRetry(`pdf:${fileId}`);
	_setStatus(fileId, "downloading");
	let result;
	try {
		result = await _downloadPdf(fileId, { fresh });
	} catch (error) {
		result = { ok: false, kind: "network", retryable: true, message: error.message };
	} finally {
		_inflight.delete(fileId);
	}

	if (result.ok) {
		_setStatus(fileId, "ready");
		console.log(`[Files] downloaded ${fileId}`);
		_queueRaw(fileId);
		_pumpRaw();
		return true;
	}
	if (fresh && isReady(fileId)) {
		// A failed Reload keeps the copy that was cached.
		_setStatus(fileId, "ready");
	} else if (_isPermanent(result)) {
		console.error(`[Files] ${fileId} is unavailable (HTTP ${result.status}) — needs the operator`);
		_setStatus(fileId, "unavailable");
	} else {
		_setStatus(fileId, "retrying");
		if (_fileMeta.has(fileId)) _scheduleRetry(`pdf:${fileId}`, () => ensureFile(fileId));
	}
	_pumpRaw();
	return false;
}

// Fetches a fresh copy of a file even though one is cached — the operator's way
// out of a copy that won't preview (a corrupt or truncated download), and the
// "Retry" on a file that is unavailable or waiting. If the new download fails,
// whatever was cached stays put.
async function redownloadFile(fileId) {
	if (!fileId || _inflight.has(fileId)) return false;
	return ensureFile(fileId, { fresh: true });
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

// Downloads every job's documents in the background (bounded concurrency, in
// job order). Safe to call on every reconcile: files that are cached, in
// flight, waiting out a retry or unavailable are skipped — their retries run on
// their own timers. Payment proofs ride along (see _syncJobProofs) so a new
// job arrives with everything the operator needs already local.
function syncJobFiles(jobs) {
	// Synchronously, before anything async: the print engine is fed the same jobs
	// right after this call and resolves file paths through _fileMeta.
	for (const job of jobs || []) _registerJobFiles(job);
	_syncJobProofs(jobs);

	const pending = [];
	for (const job of jobs || []) {
		for (const fileId of _jobFileIds(job)) {
			if (isReady(fileId)) {
				_setStatus(fileId, "ready");
				_queueRaw(fileId);
				continue;
			}
			if (_inflight.has(fileId) || _status[fileId] === "unavailable" || _waitingRetry(`pdf:${fileId}`)) continue;
			if (!pending.includes(fileId)) pending.push(fileId);
		}
	}
	if (pending.length === 0) return Promise.resolve();
	return _runLimited(pending, PDF_CONCURRENCY, (fileId) => ensureFile(fileId)).catch((err) =>
		console.error("[Files] syncJobFiles error:", err)
	);
}

// Deletes a job's folder — its documents (raw and PDF) and its payment proof —
// once it reaches a terminal state (completed/cancelled/failed). Files aren't
// previewed or reused anywhere past that point (History shows metadata only), so
// there's no reason to keep them. Best-effort: a folder that is already gone is
// not an error.
async function deleteJobFiles(jobId, fileIds) {
	for (const fileId of fileIds || []) {
		delete _status[fileId];
		_fileMeta.delete(fileId);
		_clearRetry(`pdf:${fileId}`);
		_clearRetry(`raw:${fileId}`);
		const queued = _rawQueue.indexOf(fileId);
		if (queued >= 0) _rawQueue.splice(queued, 1);
	}
	if (!jobId) return;
	try {
		await fsp.rm(jobDir(jobId), { recursive: true, force: true });
		console.log(`[Files] deleted files of job ${jobId}`);
	} catch (error) {
		console.error(`[Files] failed to delete files of job ${jobId}:`, error.message);
	}
}

// Opens a job's folder in Windows Explorer.
async function openJobFolder(jobId) {
	const dir = jobDir(jobId);
	if (!fs.existsSync(dir)) throw new Error("no files have been downloaded for this job yet");
	const error = await shell.openPath(dir);
	if (error) throw new Error(error);
}

// Removes the flat `job-files/<fileId>.pdf` cache used before files were kept in
// per-job folders. Called once at startup; anything still needed is downloaded
// again into its job's folder on the first reconcile.
async function clearLegacyFileCache() {
	let entries = [];
	try {
		entries = await fsp.readdir(getFilesDir(), { withFileTypes: true });
	} catch (error) {
		console.error("[Files] could not read the file cache:", error.message);
		return;
	}
	const loose = entries.filter((entry) => entry.isFile());
	await Promise.all(
		loose.map((entry) =>
			fsp.unlink(path.join(getFilesDir(), entry.name)).catch((error) => {
				if (error.code !== "ENOENT") console.error(`[Files] could not clear ${entry.name}:`, error.message);
			})
		)
	);
	if (loose.length) console.log(`[Files] cleared ${loose.length} file(s) from the old flat cache`);
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

// proof fileId -> jobId for the proofs of active jobs (see _syncJobProofs). Those
// are stored in the job's folder beside its documents, as payment-proof.<ext>. A
// proof with no active job — one fetched on demand from History — goes to the
// shared payment-proofs cache as <fileId>.<ext> instead, which clearProofCache
// wipes at startup.
const _proofJobs = new Map();

// Folder and file-name stem a proof is stored under.
function _proofLocation(fileId) {
	const jobId = _proofJobs.get(fileId);
	return jobId ? { dir: jobDir(jobId), stem: "payment-proof" } : { dir: getProofsDir(), stem: fileId };
}

// fileId -> path on disk. The extension isn't derivable from the id, so a cache
// miss falls back to scanning the directory. In practice every proof downloaded
// this session is in the map; the scan is what makes a proof left in a job
// folder by a previous session usable.
const _proofPaths = new Map();

function proofPath(fileId) {
	if (!fileId) return null;
	if (_proofPaths.has(fileId)) return _proofPaths.get(fileId);
	const { dir, stem } = _proofLocation(fileId);
	let found = null;
	try {
		for (const name of fs.readdirSync(dir)) {
			if (name.startsWith(`${stem}.`) && !name.endsWith(".part")) {
				found = path.join(dir, name);
				break;
			}
		}
	} catch (error) {
		if (error.code !== "ENOENT") console.error("[Files] could not scan payment proofs:", error.message);
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
// renderer's FilesContext tracks both without knowing the difference. Retried
// like a document while it can't be fetched; a proof never fails its job.
async function ensureProof(fileId) {
	if (!fileId) return false;

	if (isProofReady(fileId)) {
		_setStatus(fileId, "ready");
		return true;
	}
	if (_inflight.has(fileId)) return false;

	_inflight.add(fileId);
	_clearRetry(`proof:${fileId}`);
	_setStatus(fileId, "downloading");
	const { dir, stem } = _proofLocation(fileId);
	const part = path.join(dir, `${stem}.download.part`);
	let result;
	try {
		// No Accept header: a proof is served as the customer uploaded it.
		result = await _streamToPart(fileId, part, {});
		if (result.ok) {
			const handle = await fsp.open(part, "r");
			const head = Buffer.alloc(16);
			try {
				await handle.read(head, 0, 16, 0);
			} finally {
				await handle.close();
			}
			const ext = _sniffProofExt(head, result.contentType);
			if (!ext) console.warn(`[Files] payment proof ${fileId}: unrecognised type "${result.contentType}"`);
			const dest = path.join(dir, `${stem}.${ext || "bin"}`);
			await fsp.rename(part, dest);
			_proofPaths.set(fileId, dest);
		}
	} catch (error) {
		result = { ok: false, kind: "network", retryable: true, message: error.message };
	} finally {
		_inflight.delete(fileId);
	}

	if (result.ok) {
		_clearRetry(`proof:${fileId}`);
		_setStatus(fileId, "ready");
		console.log(`[Files] downloaded payment proof ${fileId}`);
		_pumpRaw();
		return true;
	}
	if (_isPermanent(result)) {
		console.error(`[Files] payment proof ${fileId} is unavailable (HTTP ${result.status})`);
		_setStatus(fileId, "unavailable");
	} else {
		_setStatus(fileId, "retrying");
		_scheduleRetry(`proof:${fileId}`, () => ensureProof(fileId));
	}
	_pumpRaw();
	return false;
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

// Downloads the payment proof of every job that has one. A proof waiting out a
// retry, or unavailable, is skipped — its own timer retries it, and the
// renderer can ask for another attempt (files:ensure-proof).
function _syncJobProofs(jobs) {
	const pending = [];
	for (const job of jobs || []) {
		const proofId = _jobProofId(job);
		if (!proofId) continue;
		_jobProofs.set(job._id, proofId);
		_proofJobs.set(proofId, job._id);
		if (isProofReady(proofId) || _inflight.has(proofId) || _status[proofId] === "unavailable" || _waitingRetry(`proof:${proofId}`)) continue;
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
	_proofJobs.delete(proofId); // a later History fetch goes to the shared cache
	delete _status[proofId];
	_clearRetry(`proof:${proofId}`);
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

// Path of a document's raw upload in its job folder, or null when there is none
// (the upload was already a PDF, or saving it failed). A name without an
// extension got one from the backend's reported type (see _downloadToCache), so
// that case is found by scanning for "<rawName>.<ext>" — skipping the PDF
// rendition, which shares the stem.
function rawPath(fileId) {
	const meta = _fileMeta.get(fileId);
	if (!meta?.rawName) return null;
	const dir = jobDir(meta.jobId);
	const exact = path.join(dir, meta.rawName);
	if (fs.existsSync(exact)) return exact;
	if (meta.rawHasExt) return null;
	try {
		const name = fs
			.readdirSync(dir)
			.find((n) => n.startsWith(`${meta.rawName}.`) && n !== meta.pdfName && !n.endsWith(".part"));
		return name ? path.join(dir, name) : null;
	} catch {
		return null;
	}
}

// What the renderer needs to offer "open the original": its file name, or null.
function getRawFileInfo(fileId) {
	const target = rawPath(fileId);
	return target ? { name: path.basename(target), ext: path.extname(target).slice(1).toLowerCase() } : null;
}

// Opens a cached document in the OS default application — the PDF rendition
// (e.g. in the system PDF viewer), or with `raw` the customer's original upload
// (e.g. a .docx in Word).
async function openFile(fileId, { raw = false } = {}) {
	await ensureFile(fileId);
	if (!isReady(fileId)) throw new Error("file not ready");
	const target = raw ? rawPath(fileId) : localPath(fileId);
	if (!target) throw new Error("the original file isn't available");
	const error = await shell.openPath(target);
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

	// File settings say "none" for single-sided; without mapping it the printer's
	// own default applied, which on a duplex-by-default printer prints both sides.
	const duplex = { none: "simplex", single: "simplex", long: "longEdge", short: "shortEdge", double: "longEdge" }[settings.sidedness];
	if (duplex) options.duplexMode = duplex;
	if (settings.pagesPerSheet > 1) options.pagesPerSheet = settings.pagesPerSheet;

	const ranges = parsePageRanges(settings.pageSelection);
	if (ranges) options.pageRanges = ranges;

	return options;
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
	syncJobFiles,
	retryAll,
	getStatusMap,
	setNotifier,
	addStatusListener,
	isReady,
	redownloadFile,
	openFile,
	getRawFileInfo,
	buildPrintOptions,
	printAndVerify,
	deleteJobFiles,
	openJobFolder,
	clearLegacyFileCache,
	ensureProof,
	openProof,
	deleteJobProof,
	clearProofCache,
	registerFileSchemePrivileges,
	registerFileProtocol,
};
