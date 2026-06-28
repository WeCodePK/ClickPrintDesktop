const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { app, protocol } = require("electron");
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
	registerFileSchemePrivileges,
	registerFileProtocol,
};
