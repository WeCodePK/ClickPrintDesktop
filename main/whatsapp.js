const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const QRCode = require("qrcode");
const pino = require("pino");
const { pipeline } = require("stream/promises");
const api = require("./api");
const store = require("./store");
const { MAX_UPLOAD_BYTES, mediaOf, mediaSize, uploadName, uploadErrorReply } = require("./whatsappDocuments");
const { textOf, createOrderCore } = require("./whatsappOrders");
const { createMenuFlow } = require("./whatsappMenuFlow");
const { createChatFlow } = require("./whatsappChatFlow");
const { createExcludedContacts } = require("./whatsappContacts");
const { createWelcome } = require("./whatsappWelcome");
const { createJobNotifications } = require("./whatsappJobNotifications");
const { createWhatsAppJobs } = require("./whatsappJobs");
const { getAuth } = require("./state");

// The shop's linked WhatsApp account, driven by Baileys. One socket per app
// (the single-instance lock in main.js guarantees that), scoped to the selected
// shop. Documents and photos customers send are uploaded to /api/files and
// collected into a draft per customer, which one of two ordering flows then
// talks them through — a numbered menu (whatsappMenuFlow.js) or an AI chat
// (whatsappChatFlow.js) — picked per shop in Settings. The backend sends text
// back out through the "whatsappSend" SSE event (see api.js).
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
const excludedContacts = createExcludedContacts(store);
const jobNotifications = createJobNotifications(store);
let _jobActions = null;
const jobCommands = createWhatsAppJobs({
	api,
	store,
	withStatuses: (jobs) => _jobActions?.withStatuses(jobs) || jobs,
	cancelJob: (job) => _jobActions?.cancelJob(job) || { success: false },
});

function setJobActions(actions) {
	_jobActions = actions;
}

const orders = createOrderCore({
	api,
	load: () => store.get("whatsappDrafts") || {},
	save: (map) => store.set("whatsappDrafts", map),
	loadSessions: () => store.get("whatsappChatSessions") || {},
	saveSessions: (map) => store.set("whatsappChatSessions", map),
	loadExpired: () => store.get("whatsappExpiredDrafts") || {},
	saveExpired: (map) => store.set("whatsappExpiredDrafts", map),
});
const welcome = createWelcome(orders, api, (shopId) => {
	const auth = getAuth();
	return auth.shopId === shopId ? auth.shopName : null;
});

// The ordering flows being tried out, by the name the settings store. Each has
// addFile(shopId, customer, file, name, { morePending }) and handleText(shopId,
// customer, text), both resolving the reply (a text, or an array of texts sent
// as separate messages) or null; the chat flow also has
// flush() for a held-back "files received" reply. Removing a flow: delete its
// file and its entry here (and its option in WhatsAppSettings.jsx).
const FLOWS = {
	menu: createMenuFlow(orders),
	chat: createChatFlow(orders, api),
};
const DEFAULT_FLOW = "menu";

// One promise chain per chat: a customer's documents and commands are handled
// strictly in order, so a burst of documents lands in one draft and a "confirm"
// sent right after them waits for their uploads.
const _chatQueues = new Map();

// Files per chat queued but not yet being handled, so a flow can answer a burst
// of files (an album) once instead of per file.
const _pendingMedia = new Map();

// state: "idle" | "connecting" | "qr" | "open" | "reconnecting" | "logged_out"
// enabled: false while the operator has paused message handling (see setEnabled).
// flow: the shop's ordering flow for new orders (see setFlow).
// excludedContacts: saved on this device for the selected shop.
let _snapshot = { state: "idle", qr: null, me: null, error: null, enabled: true, flow: DEFAULT_FLOW, excludedContacts: [] };
let _notify = null;

let _shopId = null;
let _sock = null;
let _retryTimer = null;
let _draftTimer = null;
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
	_set({ enabled: isEnabled(shopId), flow: flowSetting(shopId), excludedContacts: excludedContacts.list(shopId) });
	if (!_draftTimer) {
		const cleanDrafts = () => {
			orders.expireIdle(shopId);
			void orders.flushExpired(shopId);
			void flushReadyNotifications();
			jobCommands.expireSelections();
		};
		cleanDrafts();
		_draftTimer = setInterval(cleanDrafts, 30 * 1000);
		_draftTimer.unref?.();
	}
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
		void flushReadyNotifications();
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

// Whether the shop's incoming messages are handled. Paused shops are listed in
// the store, so the switch survives restarts; the default is on.
function isEnabled(shopId) {
	return !(store.get("whatsappPaused") || {})[shopId];
}

// Settings "WhatsApp" switch: pauses or resumes message handling for the current
// shop. The socket stays connected either way — paused messages are simply
// ignored, and not handled later.
function setEnabled(enabled) {
	if (!_shopId) return { success: false, message: "No shop selected." };
	const paused = store.get("whatsappPaused") || {};
	if (enabled) delete paused[_shopId];
	else paused[_shopId] = true;
	store.set("whatsappPaused", paused);
	console.log(`[WA] message handling ${enabled ? "resumed" : "paused"}`);
	_set({ enabled: !!enabled });
	return { success: true };
}

// The shop's ordering flow for new orders, from the store; the menu by default.
function flowSetting(shopId) {
	const flow = (store.get("whatsappFlow") || {})[shopId];
	return FLOWS[flow] ? flow : DEFAULT_FLOW;
}

// Settings "Conversation style": which flow the current shop uses for new
// orders. A customer already mid-order keeps the flow their draft started in.
function setFlow(flow) {
	if (!_shopId) return { success: false, message: "No shop selected." };
	if (!FLOWS[flow]) return { success: false, message: "Unknown conversation style." };
	const flows = store.get("whatsappFlow") || {};
	flows[_shopId] = flow;
	store.set("whatsappFlow", flows);
	console.log(`[WA] ordering flow set to ${flow}`);
	_set({ flow });
	return { success: true };
}

function addExcludedContact(contact) {
	if (!_shopId) return { success: false, message: "No shop selected." };
	const result = excludedContacts.add(_shopId, contact);
	if (result.success) _set({ excludedContacts: result.data });
	return result;
}

function removeExcludedContact(id) {
	if (!_shopId) return { success: false, message: "No shop selected." };
	const result = excludedContacts.remove(_shopId, id);
	if (result.success) _set({ excludedContacts: result.data });
	return result;
}

async function _canHandle(sock, shopId, msg) {
	if (_shopId !== shopId || sock !== _sock || !_snapshot.enabled) return false;
	if (await excludedContacts.isExcluded(shopId, msg, sock)) return false;
	return _shopId === shopId && sock === _sock && _snapshot.enabled;
}

// The flow handling this customer: their open draft's, else the shop's.
function _flowFor(shopId, customer) {
	return FLOWS[orders.flowOf(shopId, customer.number)] || FLOWS[flowSetting(shopId)];
}

// Handles genuinely incoming one-to-one messages (not our own sends, groups or
// status updates): documents and photos go into the customer's draft, and text messages
// drive its settings menu and "confirm" / "cancel". Text that isn't meant for
// the order flow gets no reply. Every one is marked delivered; only the ones the
// app acts on are marked read. Paused and excluded contacts aren't processed.
async function _onMessagesUpsert(sock, shopId, { type, messages }) {
	if (type !== "notify") return;
	const { isPnUser, isLidUser } = await baileys();
	const incoming = (messages || []).filter((m) => {
		const jid = m.key?.remoteJid;
		return !m.key?.fromMe && (isPnUser(jid) || isLidUser(jid));
	});
	for (const msg of incoming) _markDelivered(sock, msg);

	if (!_snapshot.enabled) {
		if (incoming.length) console.log(`[WA] paused — ignoring ${incoming.length} message(s)`);
		return;
	}
	for (const original of incoming) {
		let content = original.message;
		// Disappearing chats wrap ordinary messages in ephemeralMessage.
		while (content?.ephemeralMessage?.message) content = content.ephemeralMessage.message;
		const msg = content === original.message ? original : { ...original, message: content };
		const jid = msg.key.remoteJid;
		if (mediaOf(msg)) {
			_pendingMedia.set(jid, (_pendingMedia.get(jid) || 0) + 1);
			_enqueue(jid, () => _onMedia(sock, shopId, msg));
			continue;
		}
		const text = textOf(msg);
		if (content && !content.protocolMessage && !content.senderKeyDistributionMessage && !content.reactionMessage) {
			_enqueue(jid, () => _onText(sock, shopId, msg, text || ""));
		}
	}
}

// Delivery receipt (two grey ticks). Baileys only sends one itself while the
// socket is marked online; otherwise its receipt is "inactive", which the
// sender sees as a single tick. We stay offline so the shop's phone keeps
// getting notifications, and send the receipt explicitly.
async function _markDelivered(sock, msg) {
	try {
		await sock.sendReceipt(msg.key.remoteJid, msg.key.participant, [msg.key.id], undefined);
	} catch (error) {
		console.error(`[WA] delivery receipt for ${msg.key.id} failed:`, error.message);
	}
}

// Read receipt (blue ticks, if the account shares read receipts). Also marks
// the message read on the shop's phone.
async function _markRead(sock, msg) {
	try {
		await sock.readMessages([msg.key]);
	} catch (error) {
		console.error(`[WA] read receipt for ${msg.key.id} failed:`, error.message);
	}
}

function _enqueue(jid, task) {
	const next = (_chatQueues.get(jid) || Promise.resolve())
		.then(task)
		.catch((error) => console.error(`[WA] handling a message from ${jid} failed:`, error));
	_chatQueues.set(jid, next);
	next.then(() => {
		if (_chatQueues.get(jid) === next) _chatQueues.delete(jid);
	});
}

async function _onMedia(sock, shopId, msg) {
	const jid = msg.key.remoteJid;
	const left = (_pendingMedia.get(jid) || 1) - 1;
	if (left > 0) _pendingMedia.set(jid, left);
	else _pendingMedia.delete(jid);
	// The operator may exclude this contact while the message waits in its queue.
	if (!await _canHandle(sock, shopId, msg)) return;
	_markRead(sock, msg);

	const uploaded = await _handleMedia(sock, shopId, msg);
	if (!await _canHandle(sock, shopId, msg)) return;
	// Checked after the upload: files arriving meanwhile are part of the burst.
	const morePending = _pendingMedia.has(jid);
	const customer = await _customerOf(sock, msg);
	if (!await _canHandle(sock, shopId, msg)) return;
	jobCommands.clear(shopId, customer.number);
	orders.expire(orders.keyOf(shopId, customer.number));
	const flow = _flowFor(shopId, customer);

	if (!uploaded) {
		// This file failed (the customer was told); earlier ones may still be
		// waiting for their "received" reply.
		const held = !morePending && flow.flush ? flow.flush(shopId, customer) : null;
		if (held) await _reply(shopId, msg, held);
		return;
	}
	const reply = await flow.addFile(shopId, customer, uploaded.file, uploaded.name, { morePending, messageId: msg.key.id });
	if (reply) await _reply(shopId, msg, reply);
}

async function _onText(sock, shopId, msg, text) {
	if (!await _canHandle(sock, shopId, msg)) return;
	const customer = await _customerOf(sock, msg);
	if (!await _canHandle(sock, shopId, msg)) return;
	const key = orders.keyOf(shopId, customer.number);
	orders.expire(key);
	const greeting = await welcome.message(shopId, customer, text);
	if (greeting) {
		if (!await _reply(shopId, msg, greeting)) return;
		welcome.sent(shopId, customer);
		_markRead(sock, msg);
	}
	if (!await _canHandle(sock, shopId, msg)) return;
	const jobReply = await jobCommands.handleText(shopId, customer, text, {
		hasDraft: !!orders.getEntry(key),
		canHandle: () => _canHandle(sock, shopId, msg),
	});
	if (jobReply) {
		let sent = false;
		if (jobReply.reply && await _canHandle(sock, shopId, msg)) {
			_markRead(sock, msg);
			sent = await _reply(shopId, msg, jobReply.reply);
		}
		// Never accept serial numbers from a menu that wasn't sent successfully.
		if (jobReply.selection && !sent) jobCommands.clear(shopId, customer.number);
		return;
	}
	// The first non-document message still gets the welcome, while a job query
	// in that same message is handled above instead of being swallowed.
	if (greeting && !orders.getEntry(key)) return;
	if (orders.flowOf(shopId, customer.number) === "menu") orders.prepare(key);
	const quotedMessageId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
	const reply = await _flowFor(shopId, customer).handleText(shopId, customer, text, { quotedMessageId });
	if (!reply) return; // ordinary chat: left unread for the shop
	if (!await _canHandle(sock, shopId, msg)) return;
	_markRead(sock, msg);
	await _reply(shopId, msg, reply);
}

// { name, number } for the draft: the sender's WhatsApp display name and phone
// number. Chats addressed by LID (WhatsApp's private id) carry the phone number
// in remoteJidAlt, or Baileys may know the mapping; the LID's digits are the
// last resort.
async function _customerOf(sock, msg) {
	const { isPnUser, isLidUser } = await baileys();
	const jid = msg.key.remoteJid;
	let pn = [jid, msg.key.remoteJidAlt].find((j) => isPnUser(j));
	if (!pn && isLidUser(jid)) {
		pn = await sock.signalRepository?.lidMapping?.getPNForLID(jid).catch(() => null);
		if (!pn) console.warn(`[WA] no phone number known for ${jid} — using its LID`);
	}
	const number = (pn || jid).split("@")[0].split(":")[0].replace(/\D/g, "");
	// An opaque LID is not proof of ownership of a phone number's submitted jobs.
	return { name: msg.pushName || number, number, numberIsPhone: !!pn };
}

function documentsDir(shopId) {
	return path.join(app.getPath("userData"), "whatsapp-files", String(shopId));
}

// Downloads a customer's document or photo into whatsapp-files/<shopId>/ and
// uploads it to the backend. Returns { file, name } — the backend's File object
// and the name it was uploaded under — or null after replying to the customer
// with what went wrong. The local copy is kept either way.
async function _handleMedia(sock, shopId, msg) {
	const media = mediaOf(msg);
	const name = uploadName(media.fileName, media.mimetype);
	const from = msg.key?.remoteJid;
	console.log(`[WA] ${media.kind} "${name}" from ${from} (${msg.key?.id})`);

	const size = mediaSize(media);
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

	if (!await _canHandle(sock, shopId, msg)) return null;
	const result = await api.uploadFile(filePath, { filename: name, filetype: media.mimetype });
	if (result.success) return { file: result.data, name };
	await _reply(shopId, msg, uploadErrorReply(name, result));
	return null;
}

// Replies to a customer's message on whichever socket is current — an upload
// can outlive a reconnect. A reply can be several messages (an array), sent in
// order with only the first quoting the customer's. Dropped (and logged) when
// the shop changed or WhatsApp isn't connected.
async function _reply(shopId, msg, reply) {
	const jid = msg.key?.remoteJid;
	const texts = [].concat(reply);
	for (const [i, text] of texts.entries()) {
		if (_shopId !== shopId || !_sock || _snapshot.state !== "open") {
			console.error(`[WA] dropped reply to ${jid}: not connected`);
			return false;
		}
		if (!await _canHandle(_sock, shopId, msg)) return false;
		try {
			await _sock.sendMessage(jid, { text }, i === 0 ? { quoted: msg } : undefined);
			console.log(`[WA] replied to ${jid}: ${text}`);
		} catch (error) {
			console.error(`[WA] reply to ${jid} failed:`, error.message);
			return false; // don't send the rest out of order
		}
	}
	return true;
}

// Accepts a bare phone number (any formatting) or a full JID (…@lid,
// …@s.whatsapp.net) and returns the JID to send to.
function toJid(to) {
	const value = String(to || "").trim();
	if (value.includes("@")) return value;
	const digits = value.replace(/\D/g, "");
	return digits ? `${digits}@s.whatsapp.net` : null;
}

// Called only after the completion PATCH succeeds, for both manual and
// automatic printing. Persist first; WhatsApp can reconnect later.
function notifyJobReady(job) {
	if (jobNotifications.enqueue(job)) void flushReadyNotifications();
}

function flushReadyNotifications() {
	const shopId = _shopId;
	const sock = _sock;
	if (!shopId || !sock || _snapshot.state !== "open") return;
	return jobNotifications.flush(shopId, async ({ id, to, text }) => {
		if (_shopId !== shopId || _sock !== sock || _snapshot.state !== "open") return false;
		const jid = toJid(to);
		if (!jid) return false;
		try {
			const sent = await sock.sendMessage(jid, { text });
			if (!sent?.key?.id) return false;
			console.log(`[WA] sent ready notification ${id} (${sent.key.id})`);
			return true;
		} catch (error) {
			console.error(`[WA] ready notification ${id} failed:`, error.message);
			return false;
		}
	});
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
	clearInterval(_draftTimer);
	_draftTimer = null;
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
	_set({ state: "idle", qr: null, me: null, error: null, enabled: true, flow: DEFAULT_FLOW, excludedContacts: [] });
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

module.exports = { start, connect, disconnect, unlink, setEnabled, setFlow, addExcludedContact, removeExcludedContact, sendText, notifyJobReady, setJobActions, getSnapshot, setNotifier };
