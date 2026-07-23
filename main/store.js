const fs = require("fs");
const path = require("path");
const { app } = require("electron");

// Tiny JSON-file persistence under userData. Used to remember the auth session
// (so the operator stays logged in across restarts) and app settings like the
// automated-printing flag.
// Reads/writes are synchronous and best-effort — a corrupt/missing file is
// treated as empty rather than throwing.

let _file = null;
function file() {
	if (!_file) _file = path.join(app.getPath("userData"), "clickprint-store.json");
	return _file;
}

function readStore() {
	try {
		return JSON.parse(fs.readFileSync(file(), "utf8")) || {};
	} catch {
		return {};
	}
}

function writeStore(data) {
	try {
		fs.writeFileSync(file(), JSON.stringify(data, null, 2));
	} catch (error) {
		console.error("[Store] write failed:", error.message);
	}
}

function get(key) {
	return readStore()[key];
}

function set(key, value) {
	const data = readStore();
	data[key] = value;
	writeStore(data);
}

function remove(key) {
	const data = readStore();
	delete data[key];
	writeStore(data);
}

module.exports = { get, set, remove };
