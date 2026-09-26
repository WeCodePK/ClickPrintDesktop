const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { app } = require("electron");

// The last history the backend returned, kept on disk so the Dashboard and
// History can show it when a later fetch fails (offline, server down). Only the
// latest fetch is kept (each save replaces the file), trimmed to the fields the
// screens use (slimJob). Jobs are stored rather than computed stats, so
// date-relative figures ("today") stay right when recomputed later. Kept apart from store.js, which rewrites its whole file
// synchronously on every call — fine for settings, not for a growing list.

let _file = null;
function file() {
	if (!_file) _file = path.join(app.getPath("userData"), "history-cache.json");
	return _file;
}

// Only what the Dashboard, History tab and Jobs & History table read, in the
// backend's own shape so a saved job drops straight into the same code as a
// fresh one. Left out: `shop` (always the logged-in shop), `statusHistory` (never
// displayed), and anything else the backend adds later. If a screen starts
// reading a new job field, add it here or it will be missing while offline.
function slimJob(job) {
	const by = job.createdBy;
	const proof = job.paymentProofFile;
	return {
		_id: job._id,
		status: job.status,
		createdAt: job.createdAt,
		cost: job.cost
			? {
					total: job.cost.total,
					lines: (job.cost.lines || []).map(({ item, quantity, rate, subtotal }) => ({ item, quantity, rate, subtotal })),
					extra: (job.cost.extra || []).map(({ item, subtotal }) => ({ item, subtotal })),
				}
			: job.cost,
		price: job.price,
		additionalComments: job.additionalComments,
		// The id is all the proof tile needs; null (attached but unresolved) is kept.
		paymentProofFile: proof && typeof proof === "object" ? { _id: proof._id } : proof,
		createdBy: by && typeof by === "object" ? { _id: by._id, name: by.name, number: by.number } : by,
		files: (job.files || []).map((entry) => ({
			file: entry.file
				? {
						_id: entry.file._id,
						name: entry.file.name,
						numberOfPages: entry.file.numberOfPages,
					}
				: entry.file,
			fileId: entry.fileId,
			name: entry.name,
			numberOfPages: entry.numberOfPages,
			settings: entry.settings,
		})),
	};
}

// { shopId, fetchedAt, data } for the given shop, or null.
function load(shopId) {
	try {
		const cached = JSON.parse(fs.readFileSync(file(), "utf8"));
		return cached?.shopId === shopId && Array.isArray(cached.data) ? cached : null;
	} catch {
		return null;
	}
}

async function save(shopId, data) {
	const tmp = `${file()}.part`;
	try {
		const slim = (data || []).map(slimJob);
		await fsp.writeFile(tmp, JSON.stringify({ shopId, fetchedAt: new Date().toISOString(), data: slim }));
		await fsp.rename(tmp, file());
	} catch (error) {
		console.error("[HistoryCache] save failed:", error.message);
	}
}

// Called on logout: another account may use this machine next.
async function clear() {
	try {
		await fsp.unlink(file());
	} catch (error) {
		if (error.code !== "ENOENT") console.error("[HistoryCache] clear failed:", error.message);
	}
}

module.exports = { load, save, clear };
