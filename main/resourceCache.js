const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { app } = require("electron");

// The last good copy of a backend resource (jobs, shop, services, printers,
// history), kept on disk so the app keeps working from it while the backend
// can't be reached — screens render, the print engine routes, WhatsApp answers.
// One file per resource holding { shopId, fetchedAt, data }; only the latest
// fetch is kept, and only for the shop it was fetched for.
//
// Kept apart from store.js, which rewrites its whole file synchronously on every
// call — fine for settings, not for a job list saved on every reconcile.

const _caches = [];

// name: file stem under userData ("jobs-cache" → jobs-cache.json).
// slim: optional (data) => data trimmed to what's worth keeping.
function createResourceCache(name, { slim = (data) => data } = {}) {
	let _file = null;
	const file = () => (_file ||= path.join(app.getPath("userData"), `${name}.json`));
	// Saves run one at a time, so two quick reconciles can't interleave on the
	// same .part file.
	let chain = Promise.resolve();

	// { shopId, fetchedAt, data } for the given shop, or null.
	function load(shopId) {
		try {
			const cached = JSON.parse(fs.readFileSync(file(), "utf8"));
			return cached?.shopId === shopId && cached.data !== undefined ? cached : null;
		} catch {
			return null;
		}
	}

	function save(shopId, data) {
		if (!shopId) return chain;
		const fetchedAt = new Date().toISOString();
		chain = chain.then(async () => {
			const tmp = `${file()}.part`;
			try {
				await fsp.writeFile(tmp, JSON.stringify({ shopId, fetchedAt, data: slim(data) }));
				await fsp.rename(tmp, file());
			} catch (error) {
				console.error(`[Cache] ${name} save failed:`, error.message);
			}
		});
		return chain;
	}

	// Called on logout: another account may use this machine next.
	function clear() {
		chain = chain.then(async () => {
			try {
				await fsp.unlink(file());
			} catch (error) {
				if (error.code !== "ENOENT") console.error(`[Cache] ${name} clear failed:`, error.message);
			}
		});
		return chain;
	}

	const cache = { load, save, clear };
	_caches.push(cache);
	return cache;
}

// Wipes every resource cache (logout).
function clearAll() {
	return Promise.all(_caches.map((cache) => cache.clear()));
}

// Serves `result` when it succeeded (saving it), else the cached copy marked
// stale — `{ success: true, data, stale: true, fetchedAt, message }` — so a
// screen keeps showing data instead of an error. With no cache, the failure
// itself is returned.
function readThrough(cache, shopId, result, label) {
	if (result?.success) {
		cache.save(shopId, result.data);
		return result;
	}
	const cached = cache.load(shopId);
	if (!cached) return result;
	console.warn(`[Cache] ${label} failed (${result?.message}) — serving copy from ${cached.fetchedAt}`);
	return { success: true, data: cached.data, stale: true, fetchedAt: cached.fetchedAt, message: result?.message, offline: !!result?.offline };
}

module.exports = { createResourceCache, clearAll, readThrough };
