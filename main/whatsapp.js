const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const QRCode = require("qrcode");
const pino = require("pino");
const { pipeline } = require("stream/promises");
const { postWhatsAppWebhook, uploadFile } = require("./api");
const { MAX_UPLOAD_BYTES, documentOf, documentSize, uploadName, uploadErrorReply } = require("./whatsappDocuments");

// The shop's linked WhatsApp account, driven by Baileys. One socket per app
// (the single-instance lock in main.js guarantees that), scoped to the selected
// shop. Incoming messages are forwarded raw to the backend webhook (documents
// are uploaded to /api/files first); the backend sends text back out through the
// "whatsappSend" SSE event (see api.js).
//
// Credentials live under userData/whatsapp/<shopId>, so a linked device
// survives restarts and app logout — only "Unlink" (or the phone removing the
// device) throws them away.

// Baileys is ESM-only; main is CommonJS, so it's loaded once on first use.
let _baileys = null;
async function baileys() {
	if (!_baileys) _baileys = await import("baileys");
	return _baileys;
}

const logger = pino({ level: "silent" });

// state: "idle" | "connecting" | "qr" | "open" | "reconnecting" | "logged_out"
let _snapshot = { state: "idle", qr: null, me: null, error: null };
let _notify = null;

let _shopId = null;
let _sock = null;
let _retryTimer = null;
let _retryDelay = 2000;
const MAX_RETRY_DELAY = 30000;

// Recently handled send ids, so an SSE replay after a reconnect can't send the
// same message twice. Insertion-ordered; trimmed to the newest SEEN_LIMIT.
const _seenSendIds = new Set();
const SEEN_LIMIT = 500;

function setNotifier(cb) {
	_notify = cb;
}

function getSnapshot() {
	return { ..._snapshot };
}

function _set(updates) {
	_snapshot = { ..._snapshot, ...updates };
	if (_notify) _notify(getSnapshot());
}

function authDir(shopId) {
	return path.join(app.getPath("userData"), "whatsapp", String(shopId));
}

// Linked once a QR scan has completed: Baileys writes creds.json as soon as a
// socket opens, but only fills in `me` after pairing.
function isLinked(shopId) {
	try {
		const creds = JSON.parse(fs.readFileSync(path.join(authDir(shopId), "creds.json"), "utf8"));
		return !!creds?.me?.id;
	} catch {
		return false;
	}
}

function clearCreds(shopId) {
	try {
		fs.rmSync(authDir(shopId), { recursive: true, force: true });
	} catch (error) {
		console.error("[WA] could not clear credentials:", error.message);
	}
}

// Called whenever a shop session begins (login or restore). A previously linked
// device reconnects on its own; an unlinked one waits for the operator to press
// Connect, so no QR codes are generated while nobody is looking at them.
function start(shopId) {
	if (!shopId) return;
	if (_shopId !== shopId) _teardown();
	_shopId = shopId;
	if (_sock) return;
	if (isLinked(shopId)) {
		console.log("[WA] linked device found — reconnecting");
		_connect();
	} else {
		_set({ state: "idle", qr: null, me: null, error: null });
	}
}

// Operator-initiated (drawer "Connect"): opens a socket, which shows a QR when
// the shop isn't linked yet.
async function connect() {
	if (!_shopId) return { success: false, message: "No shop selected." };
	if (_sock) return { success: true };
	_set({ error: null });
	await _connect();
	return { success: true };
}

async function _connect() {
	clearTimeout(_retryTimer);
	_retryTimer = null;
	const shopId = _shopId;
	if (!shopId) return;

	_set({ state: _snapshot.state === "reconnecting" ? "reconnecting" : "connecting", qr: null });

	let sock;
	try {
		const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = await baileys();
		const { state, saveCreds } = await useMultiFileAuthState(authDir(shopId));
		// Falls back to Baileys' bundled version if the lookup fails (offline).
		const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

		// The shop changed (logout / another shop) while we were awaiting.
		if (_shopId !== shopId || _sock) return;

		sock = makeWASocket({
			auth: state,
			version,
			logger,
			browser: Browsers.windows("ClickPrint"),
			markOnlineOnConnect: false,
			syncFullHistory: false,
		});
		_sock = sock;
		sock.ev.on("creds.update", saveCreds);
	} catch (error) {
		console.error("[WA] failed to start socket:", error);
		_set({ state: "idle", qr: null, error: "Couldn't start WhatsApp. Please try again." });
		return;
	}

	sock.ev.on("connection.update", (update) => _onConnectionUpdate(sock, shopId, update));
	sock.ev.on("messages.upsert", (event) => _onMessagesUpsert(sock, shopId, event));
}

async function _onConnectionUpdate(sock, shopId, { connection, lastDisconnect, qr }) {
	// Events from a socket we've since replaced or torn down.
	if (sock !== _sock) return;

	if (qr) {
		try {
			_set({ state: "qr", qr: await QRCode.toDataURL(qr, { margin: 1, width: 280 }), error: null });
		} catch (error) {
			console.error("[WA] QR render failed:", error.message);
		}
	}

	if (connection === "open") {
		console.log("[WA] connected as", sock.user?.id);
		_retryDelay = 2000;
		_set({
			state: "open",
			qr: null,
			error: null,
			me: { id: sock.user?.id ?? null, lid: sock.user?.lid ?? null, name: sock.user?.name ?? null },
		});
		return;
	}

	if (connection !== "close") return;

	const { DisconnectReason } = await baileys();
	const code = lastDisconnect?.error?.output?.statusCode;
	console.log("[WA] connection closed:", code, lastDisconnect?.error?.message);
	_sock = null;

	if (code === DisconnectReason.loggedOut) {
		// The device was removed from the phone — the saved credentials are dead.
		clearCreds(shopId);
		_set({ state: "logged_out", qr: null, me: null, error: "WhatsApp was unlinked from the phone." });
		return;
	}
	if (code === DisconnectReason.connectionReplaced) {
		// Another session took over this device; reconnecting would just fight it.
		_set({ state: "idle", qr: null, error: "WhatsApp was opened elsewhere with this link. Click Connect to take it back." });
		return;
	}
	if (code === DisconnectReason.restartRequired) {
		// Normal right after a QR scan: WhatsApp asks for a fresh socket.
		_connect();
		return;
	}
	if (!sock.authState?.creds?.me?.id) {
		// The QR was never scanned and WhatsApp stopped issuing new ones.
		_set({ state: "idle", qr: null, error: "QR code expired — click Connect to try again." });
		return;
	}

	_set({ state: "reconnecting", qr: null });
	_retryTimer = setTimeout(_connect, _retryDelay);
	_retryDelay = Math.min(_retryDelay * 2, MAX_RETRY_DELAY);
}

// Forwards genuinely incoming messages (not our own sends, not status updates)
// to the backend as the raw Baileys event. Documents are first uploaded to
// /api/files and forwarded with the resulting File object as `uploadedFile`; a
// document that fails to upload isn't forwarded — the customer gets a reply
// explaining why instead.
async function _onMessagesUpsert(sock, shopId, { type, messages }) {
	if (type !== "notify") return;
	const incoming = (messages || []).filter(
		(m) => !m.key?.fromMe && m.key?.remoteJid !== "status@broadcast"
	);
	if (incoming.length === 0) return;

	// Plain messages go straight through; each document waits for its own upload.
	const plain = incoming.filter((m) => !documentOf(m));
	if (plain.length > 0) _forward(shopId, type, plain);

	for (const msg of incoming.filter((m) => documentOf(m))) {
		_handleDocument(sock, shopId, msg).then((file) => {
			if (file) _forward(shopId, type, [{ ...msg, uploadedFile: file }]);
		});
	}
}

function documentsDir(shopId) {
	return path.join(app.getPath("userData"), "whatsapp-files", String(shopId));
}

// Downloads a customer's document into whatsapp-files/<shopId>/ and uploads it
// to the backend. Returns the backend's File object, or null after replying to
// the customer with what went wrong. The local copy is kept either way.
async function _handleDocument(sock, shopId, msg) {
	const doc = documentOf(msg);
	const name = uploadName(doc.fileName, doc.mimetype);
	const from = msg.key?.remoteJid;
	console.log(`[WA] document "${name}" from ${from} (${msg.key?.id})`);

	const size = documentSize(doc);
	if (size != null && size > MAX_UPLOAD_BYTES) {
		console.error(`[WA] "${name}" is ${size} bytes — over the upload limit`);
		await _reply(shopId, msg, uploadErrorReply(name, { status: 413 }));
		return null;
	}

	const dir = documentsDir(shopId);
	const filePath = path.join(dir, `${msg.key?.id || Date.now()} - ${name}`);
	try {
		const { downloadMediaMessage } = await baileys();
		fs.mkdirSync(dir, { recursive: true });
		const stream = await downloadMediaMessage(msg, "stream", {}, { logger, reuploadRequest: sock.updateMediaMessage });
		await pipeline(stream, fs.createWriteStream(filePath));
	} catch (error) {
		console.error(`[WA] download of "${name}" failed:`, error.message);
		fs.rmSync(filePath, { force: true });
		await _reply(shopId, msg, uploadErrorReply(name));
		return null;
	}

	const result = await uploadFile(filePath, { filename: name, filetype: doc.mimetype });
	if (result.success) return result.data;
	await _reply(shopId, msg, uploadErrorReply(name, result));
	return null;
}

// Replies to a customer's message, quoting it, on whichever socket is current —
// an upload can outlive a reconnect. Dropped (and logged) when the shop changed
// or WhatsApp isn't connected.
async function _reply(shopId, msg, text) {
	const jid = msg.key?.remoteJid;
	if (_shopId !== shopId || !_sock || _snapshot.state !== "open") {
		console.error(`[WA] dropped reply to ${jid}: not connected`);
		return;
	}
	try {
		await _sock.sendMessage(jid, { text }, { quoted: msg });
		console.log(`[WA] replied to ${jid}: ${text}`);
	} catch (error) {
		console.error(`[WA] reply to ${jid} failed:`, error.message);
	}
}

async function _forward(shopId, type, messages) {
	const { BufferJSON } = await baileys();
	// Buffers → base64 via Baileys' replacer; protobuf Longs → plain numbers.
	const body = JSON.stringify({ shopId, type, messages }, (key, value) => {
		if (value && typeof value === "object" && typeof value.toNumber === "function" && "low" in value) {
			return value.toNumber();
		}
		return BufferJSON.replacer(key, value);
	});

	for (let attempt = 1; attempt <= 2; attempt++) {
		const result = await postWhatsAppWebhook(body);
		if (result?.success) {
			console.log(`[WA] forwarded ${messages.length} message(s) to webhook`);
			return;
		}
		console.error(`[WA] webhook POST failed (attempt ${attempt}):`, result?.message);
	}
}

// Accepts a bare phone number (any formatting) or a full JID (…@lid,
// …@s.whatsapp.net) and returns the JID to send to.
function toJid(to) {
	const value = String(to || "").trim();
	if (value.includes("@")) return value;
	const digits = value.replace(/\D/g, "");
	return digits ? `${digits}@s.whatsapp.net` : null;
}

// Handler for the backend's "whatsappSend" SSE event: { id, to, text }.
// Fire-and-forget — the outcome is only logged.
async function sendText(payload) {
	const { id, to, text } = payload || {};
	if (id != null) {
		if (_seenSendIds.has(id)) {
			console.log(`[WA] skipping duplicate send ${id}`);
			return;
		}
		_seenSendIds.add(id);
		if (_seenSendIds.size > SEEN_LIMIT) _seenSendIds.delete(_seenSendIds.values().next().value);
	}

	const jid = toJid(to);
	if (!jid || typeof text !== "string" || !text) {
		console.error(`[WA] dropped send ${id}: invalid recipient or text`);
		return;
	}
	if (!_sock || _snapshot.state !== "open") {
		console.error(`[WA] dropped send ${id}: not connected`);
		return;
	}

	try {
		const sent = await _sock.sendMessage(jid, { text });
		console.log(`[WA] sent ${id} → ${jid} (${sent?.key?.id})`);
	} catch (error) {
		console.error(`[WA] send ${id} → ${jid} failed:`, error.message);
	}
}

// Closes the socket without touching the credentials.
function _teardown() {
	clearTimeout(_retryTimer);
	_retryTimer = null;
	_retryDelay = 2000;
	const sock = _sock;
	_sock = null;
	if (sock) {
		try {
			sock.end(undefined);
		} catch {}
	}
}

// App logout: stop the socket but keep the link, so signing back in to the
// same shop reconnects without a new QR.
function disconnect() {
	_teardown();
	_shopId = null;
	_set({ state: "idle", qr: null, me: null, error: null });
}

// Drawer "Unlink": removes this device from the WhatsApp account and forgets it.
async function unlink() {
	const shopId = _shopId;
	const sock = _sock;
	_sock = null; // so the resulting close event is ignored
	clearTimeout(_retryTimer);
	_retryTimer = null;
	if (sock) {
		try {
			await sock.logout();
		} catch (error) {
			console.error("[WA] logout failed:", error.message);
			try { sock.end(undefined); } catch {}
		}
	}
	if (shopId) clearCreds(shopId);
	_set({ state: "idle", qr: null, me: null, error: null });
	return { success: true };
}

module.exports = { start, connect, disconnect, unlink, sendText, getSnapshot, setNotifier };
