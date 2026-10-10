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
const { createChatHelp } = require("./whatsappChatHelp");
const { createJobNotifications } = require("./whatsappJobNotifications");
const { createWhatsAppJobs } = require("./whatsappJobs");
const { createWhatsAppOutbox } = require("./whatsappOutbox");
const { detectLanguage } = require("./whatsappChatFlow");
const connectivity = require("./connectivity");
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
const outbox = createWhatsAppOutbox(store);
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
const chatHelp = createChatHelp(orders, welcome);

// The ordering flows being tried out, by the name the settings store. Each has
// addFile(shopId, customer, file, name, { morePending }) and handleText(shopId,
// customer, text), both resolving the reply (a text, or an array of texts sent
// as separate messages) or null; the chat flow also has
// flush() for a held-back "files received" reply. Removing a flow: delete its
// file and its entry here (and its option in WhatsAppSettings.jsx).
const FLOWS = {
	menu: createMenuFlow(orders, api, jobCommands),
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
		let prunedAt = 0;
		const cleanDrafts = () => {
			orders.expireIdle(shopId);
			void orders.flushExpired(shopId);
			void flushReadyNotifications();
			void _flushOutbox();
			jobCommands.expireSelections();
			// Parked customer messages (an upload the backend refused with a 5xx
			// doesn't flip connectivity, so nothing else would retry it).
			if (_ready()) _replayInbound(shopId);
			if (Date.now() - prunedAt > 60 * 60 * 1000) {
				prunedAt = Date.now();
				_pruneDocuments(shopId);
			}
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
		// Everything that waited for WhatsApp: queued sends, then customer
		// messages parked during the outage.
		void flushReadyNotifications();
		void _flushOutbox();
		_wakeWaiters();
		_replayInbound(shopId);
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
	if (!sock || _shopId !== shopId || sock !== _sock || !_snapshot.enabled) return false;
	if (await excludedContacts.isExcluded(shopId, msg, sock)) return false;
	return _shopId === shopId && sock === _sock && _snapshot.enabled;
}

// The flow handling this customer: their open draft's, else the shop's.
function _flowFor(shopId, customer) {
	return FLOWS[orders.flowOf(shopId, customer.number)] || FLOWS[flowSetting(shopId)];
}

async function _chatSession(shopId, msg, kind, text = "") {
	const customer = await _customerOf(_sock, msg);
	if (!await _canHandle(_sock, shopId, msg)) return true;
	orders.expire(orders.keyOf(shopId, customer.number));
	if (_flowFor(shopId, customer) !== FLOWS.chat) return false;
	const result = await chatHelp.receive(shopId, customer, { kind, text, messageId: msg.key?.id }, async (reply) => {
		if (!await _canHandle(_sock, shopId, msg)) return false;
		const sent = await _reply(shopId, msg, reply);
		if (sent) _markRead(_sock, msg);
		return sent;
	});
	return result.stop;
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
	if (!sock || !msg.message) return; // a replayed message (see _liteMsg) was read when it arrived
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

// ── Inbound work that outlives an outage ──────────────────────────────────────
// Every customer message the app acts on is saved as an inbound item before it
// is handled (a text, or a document already downloaded to disk) and removed
// once handled. Handling waits for the backend: briefly in the chat's queue
// (WAIT_ONLINE_MS), after which the item is parked — the customer is told,
// once, that the connection is slow — and replayed in order when the backend
// is back (onOnline) or WhatsApp reconnects. A restart replays them too.
// Nothing a customer sends is lost to a dropped connection, and nothing
// becomes an error message just because the Wi-Fi blinked.

const INBOUND_KEY = "whatsappPendingInbound";
const WAIT_ONLINE_MS = 3 * 60 * 1000;
const INBOUND_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const HOLDING_EVERY_MS = 10 * 60 * 1000;

const HOLDING_REPLY = {
	en: "Got it — our connection is slow right now. I'll get back to you as soon as it's back.",
	urdu: "موصول ہو گیا — اس وقت ہمارا انٹرنیٹ سست ہے۔ کنکشن بحال ہوتے ہی جواب دیتے ہیں۔",
	roman_urdu: "Mil gaya — is waqt hamara internet slow hai. Connection wapas aate hi jawab dete hain.",
};

const _activeInbound = new Set(); // item ids queued or running right now
const _holdingSentAt = new Map(); // jid -> last holding reply time
let _onlineWaiters = [];

function _inboundItems(shopId) {
	return (store.get(INBOUND_KEY) || {})[shopId] || [];
}

function _saveInbound(shopId, items) {
	const all = store.get(INBOUND_KEY) || {};
	if (items.length) all[shopId] = items;
	else delete all[shopId];
	store.set(INBOUND_KEY, all);
}

function _addInbound(shopId, item) {
	_saveInbound(shopId, [..._inboundItems(shopId).filter((i) => i.id !== item.id), item]);
}

function _removeInbound(shopId, id) {
	_saveInbound(shopId, _inboundItems(shopId).filter((i) => i.id !== id));
}

// What's needed of a message to answer it later: its key (chat, id, LID/PN
// alternates) and the sender's name. No `message`, so replies to a replayed
// message don't quote it.
function _liteMsg(item) {
	return { key: item.key, pushName: item.pushName };
}

// Whether the backend and WhatsApp can both be used right now.
const _ready = () => connectivity.isOnline() && !!_sock && _snapshot.state === "open";

// Resolves true once both are usable, or false after `ms`.
function _whenReady(ms) {
	if (_ready()) return Promise.resolve(true);
	return new Promise((resolve) => {
		const waiter = () => {
			if (!_ready()) return false;
			clearTimeout(timer);
			resolve(true);
			return true;
		};
		const timer = setTimeout(() => {
			_onlineWaiters = _onlineWaiters.filter((w) => w !== waiter);
			resolve(false);
		}, ms);
		timer.unref?.();
		_onlineWaiters.push(waiter);
	});
}

function _wakeWaiters() {
	_onlineWaiters = _onlineWaiters.filter((waiter) => !waiter());
}

// One "our connection is slow" per chat per HOLDING_EVERY_MS — for a file, or
// a text from a customer mid-order. Ordinary chat with the shop gets no bot
// reply, outage or not.
async function _sendHolding(shopId, item) {
	const last = _holdingSentAt.get(item.jid) || 0;
	if (Date.now() - last < HOLDING_EVERY_MS) return;
	if (item.kind === "text") {
		const customer = await _customerOf(_sock, _liteMsg(item));
		if (!orders.getEntry(orders.keyOf(shopId, customer.number))) return;
	}
	_holdingSentAt.set(item.jid, Date.now());
	const language = (item.kind === "text" && detectLanguage(item.text || "")) || "en";
	await _reply(shopId, _liteMsg(item), HOLDING_REPLY[language] || HOLDING_REPLY.en);
}

// Runs a saved inbound item once the backend is reachable. Leaves it saved
// (parked) when the backend doesn't come back in time or an upload couldn't
// reach it; removes it once it's been handled.
async function _runInbound(shopId, item, msg = _liteMsg(item)) {
	_activeInbound.add(item.id);
	try {
		if (Date.now() - (item.at || 0) > INBOUND_MAX_AGE_MS) {
			console.log(`[WA] dropping ${item.kind} ${item.id} from ${item.jid}: too old to act on`);
			if (item.kind === "media") _mediaDone(item.jid);
			_removeInbound(shopId, item.id);
			return;
		}
		if (!(await _whenReady(WAIT_ONLINE_MS))) {
			console.log(`[WA] ${item.kind} ${item.id} from ${item.jid} parked until the connection is back`);
			await _sendHolding(shopId, item);
			return;
		}
		const sock = _sock;
		if (!(await _canHandle(sock, shopId, msg))) {
			if (item.kind === "media") _mediaDone(item.jid);
			_removeInbound(shopId, item.id);
			return;
		}
		if (item.kind === "text") {
			await _handleText(sock, shopId, msg, item.text, item.quotedMessageId);
			_removeInbound(shopId, item.id);
			return;
		}
		const done = await _handleUpload(sock, shopId, msg, item);
		if (done) _removeInbound(shopId, item.id);
		else await _sendHolding(shopId, item);
	} catch (error) {
		// A bug, not an outage: replaying it would only repeat whatever it
		// already sent before failing.
		console.error(`[WA] handling ${item.kind} ${item.id} from ${item.jid} failed — dropping it:`, error);
		if (item.kind === "media") _mediaDone(item.jid);
		_removeInbound(shopId, item.id);
	} finally {
		_activeInbound.delete(item.id);
	}
}

// Queues every parked item of the shop (in arrival order, each in its chat's
// queue) — on reconnect, and when WhatsApp comes back.
function _replayInbound(shopId) {
	if (!shopId) return;
	for (const item of _inboundItems(shopId)) {
		if (_activeInbound.has(item.id)) continue;
		_activeInbound.add(item.id);
		_enqueue(item.jid, () => _runInbound(shopId, item));
	}
}

async function _onMedia(sock, shopId, msg) {
	const jid = msg.key.remoteJid;
	// The operator may exclude this contact while the message waits in its queue.
	if (!await _canHandle(sock, shopId, msg)) return _mediaDone(jid);
	if (await _chatSession(shopId, msg, "media")) return _mediaDone(jid);
	_markRead(sock, msg);

	const media = await _downloadMedia(sock, shopId, msg);
	if (!media) {
		_mediaDone(jid);
		// This file failed (the customer was told); earlier ones may still be
		// waiting for their "received" reply.
		const customer = await _customerOf(sock, msg);
		const flow = _flowFor(shopId, customer);
		const held = !_pendingMedia.has(jid) && flow.flush ? flow.flush(shopId, customer) : null;
		if (held) await _reply(shopId, msg, held);
		return;
	}
	const item = { id: msg.key.id || `${Date.now()}`, kind: "media", jid, key: msg.key, pushName: msg.pushName, media, at: Date.now() };
	_addInbound(shopId, item);
	await _runInbound(shopId, item, msg);
}

// One file of a burst is done with (handled, failed or parked).
function _mediaDone(jid) {
	const left = (_pendingMedia.get(jid) || 1) - 1;
	if (left > 0) _pendingMedia.set(jid, left);
	else _pendingMedia.delete(jid);
}

// Uploads a saved document and adds it to the customer's draft. Resolves true
// when the item is finished with (added, or refused for good — the customer
// told), false when the upload couldn't reach the backend and should be retried.
async function _handleUpload(sock, shopId, msg, item) {
	const jid = item.jid;
	const { filePath, name, mimetype } = item.media;
	if (!fs.existsSync(filePath)) {
		console.error(`[WA] ${name}: the downloaded copy is gone — dropping it`);
		_mediaDone(jid);
		return true;
	}
	const result = await api.uploadFile(filePath, { filename: name, filetype: mimetype });
	if (!result.success && (result.status === undefined || result.status >= 500 || result.status === 401)) {
		// Couldn't reach the backend (or it's down): keep the file, try again later.
		return false;
	}
	_mediaDone(jid);
	if (!(await _canHandle(_sock, shopId, msg))) return true;
	const customer = await _customerOf(_sock, msg);
	const key = orders.keyOf(shopId, customer.number);
	orders.expire(key);
	const flow = _flowFor(shopId, customer);
	// Also covers saved uploads replayed after a restart.
	if (flow === FLOWS.chat && await _chatSession(shopId, msg, "media")) return true;
	if (!result.success) {
		await _reply(shopId, msg, uploadErrorReply(name, result));
		const held = !_pendingMedia.has(jid) && flow.flush ? flow.flush(shopId, customer) : null;
		if (held) await _reply(shopId, msg, held);
		return true;
	}
	// Checked after the upload: files arriving meanwhile are part of the burst.
	const morePending = _pendingMedia.has(jid);
	jobCommands.clear(shopId, customer.number);
	if (flow === FLOWS.menu) orders.touchSession(key);
	const reply = await flow.addFile(shopId, customer, result.data, name, { morePending, messageId: item.key?.id });
	if (reply) await _reply(shopId, msg, reply);
	return true;
}

async function _onText(sock, shopId, msg, text) {
	if (!await _canHandle(sock, shopId, msg)) return;
	if (await _chatSession(shopId, msg, "text", text)) return;
	const item = {
		id: msg.key.id || `${Date.now()}`,
		kind: "text",
		jid: msg.key.remoteJid,
		key: msg.key,
		pushName: msg.pushName,
		text,
		quotedMessageId: msg.message?.extendedTextMessage?.contextInfo?.stanzaId,
		at: Date.now(),
	};
	_addInbound(shopId, item);
	await _runInbound(shopId, item, msg);
}

async function _handleText(sock, shopId, msg, text, quotedMessageId) {
	const customer = await _customerOf(sock, msg);
	if (!await _canHandle(sock, shopId, msg)) return;
	const key = orders.keyOf(shopId, customer.number);
	orders.expire(key);
	const flow = _flowFor(shopId, customer);
	if (flow === FLOWS.chat && await _chatSession(shopId, msg, "text", text)) return;
	if (flow === FLOWS.menu) orders.touchSession(key);
	const greeting = flow === FLOWS.menu ? await welcome.message(shopId, customer, text, "Bot") : null;
	if (greeting) {
		// The welcome must not wait for the current-jobs request to finish.
		if (!await _reply(shopId, msg, greeting)) return;
		welcome.sent(shopId, customer, "Bot");
		_markRead(sock, msg);
		if (flow === FLOWS.menu && !orders.getEntry(key)) {
			const menu = await flow.homeMenu(shopId, customer, { greeting: true, canHandle: () => _canHandle(sock, shopId, msg) });
			if (menu && !await _reply(shopId, msg, menu)) return;
		}
	}
	if (!await _canHandle(sock, shopId, msg)) return;
	const jobReply = await jobCommands.handleText(shopId, customer, text, {
		hasDraft: !!orders.getEntry(key),
		menuAction: flow.jobAction?.(shopId, customer, text),
		numberedMenu: flow === FLOWS.menu,
		canHandle: () => _canHandle(sock, shopId, msg),
	});
	if (jobReply) {
		let sent = false;
		if (jobReply.reply && await _canHandle(sock, shopId, msg)) {
			_markRead(sock, msg);
			sent = await _reply(shopId, msg, flow.withNavigation ? flow.withNavigation(jobReply.reply) : jobReply.reply);
		}
		// Never accept serial numbers from a menu that wasn't sent successfully.
		if (jobReply.selection && !sent) jobCommands.clear(shopId, customer.number);
		return;
	}
	// A numbered-menu welcome already shows the next actions. A job query in
	// that same message is handled above instead of being swallowed.
	if (greeting && !orders.getEntry(key)) return;
	if (orders.flowOf(shopId, customer.number) === "menu") orders.prepare(key);
	const reply = await flow.handleText(shopId, customer, text, { quotedMessageId, canHandle: () => _canHandle(sock, shopId, msg) });
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
		pn = await sock?.signalRepository?.lidMapping?.getPNForLID(jid).catch(() => null);
		if (!pn) console.warn(`[WA] no phone number known for ${jid} — using its LID`);
	}
	const number = (pn || jid).split("@")[0].split(":")[0].replace(/\D/g, "");
	// An opaque LID is not proof of ownership of a phone number's submitted jobs.
	return { name: msg.pushName || number, number, numberIsPhone: !!pn };
}

function documentsDir(shopId) {
	return path.join(app.getPath("userData"), "whatsapp-files", String(shopId));
}

// Downloads a customer's document or photo from WhatsApp into
// whatsapp-files/<shopId>/ — retried, since WhatsApp's media servers are as far
// away as ours. Resolves { filePath, name, mimetype }, or null after replying to
// the customer with what went wrong.
async function _downloadMedia(sock, shopId, msg) {
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
	const { downloadMediaMessage } = await baileys();
	fs.mkdirSync(dir, { recursive: true });
	for (let attempt = 1; ; attempt++) {
		try {
			const stream = await downloadMediaMessage(msg, "stream", {}, { logger, reuploadRequest: sock.updateMediaMessage });
			await pipeline(stream, fs.createWriteStream(filePath));
			return { filePath, name, mimetype: media.mimetype };
		} catch (error) {
			fs.rmSync(filePath, { force: true });
			if (attempt >= 4) {
				console.error(`[WA] download of "${name}" failed:`, error.message);
				await _reply(shopId, msg, uploadErrorReply(name));
				return null;
			}
			console.warn(`[WA] download of "${name}" failed (attempt ${attempt}), retrying:`, error.message);
			await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
		}
	}
}

// Downloaded WhatsApp files are kept a week after they were handled (the
// operator may want the original), then deleted.
const DOCUMENT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
function _pruneDocuments(shopId) {
	const dir = documentsDir(shopId);
	const keep = new Set(_inboundItems(shopId).filter((i) => i.media).map((i) => path.basename(i.media.filePath)));
	let names = [];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (keep.has(name)) continue;
		try {
			const file = path.join(dir, name);
			if (Date.now() - fs.statSync(file).mtimeMs > DOCUMENT_KEEP_MS) fs.rmSync(file, { force: true });
		} catch {}
	}
}

// Replies to a customer's message on whichever socket is current — an upload
// can outlive a reconnect. A reply can be several messages (an array), sent in
// order with only the first quoting the customer's. While WhatsApp isn't
// connected the reply waits in the outbox (whatsappOutbox.js) instead of being
// lost; it's dropped only when the shop changed. Resolves true once sent or
// queued.
async function _reply(shopId, msg, reply) {
	const jid = msg.key?.remoteJid;
	const texts = [].concat(reply);
	for (const [i, text] of texts.entries()) {
		if (_shopId !== shopId) {
			console.error(`[WA] dropped reply to ${jid}: the shop changed`);
			return false;
		}
		if (!_sock || _snapshot.state !== "open" || outbox.pendingCount(shopId) > 0) {
			// Behind anything already waiting, so the chat stays in order.
			for (const rest of texts.slice(i)) outbox.enqueueReply(shopId, jid, rest);
			void _flushOutbox(); // a no-op until WhatsApp is connected
			return true;
		}
		if (!await _canHandle(_sock, shopId, msg)) return false;
		try {
			await _sock.sendMessage(jid, { text }, i === 0 && msg.message ? { quoted: msg } : undefined);
			console.log(`[WA] replied to ${jid}: ${text}`);
		} catch (error) {
			// Retried with the rest of the outbox on the next reconnect or tick.
			console.error(`[WA] reply to ${jid} failed — queued:`, error.message);
			for (const rest of texts.slice(i)) outbox.enqueueReply(shopId, jid, rest);
			return true;
		}
	}
	return true;
}

// Sends everything queued for this shop while WhatsApp was down, in order.
function _flushOutbox() {
	const shopId = _shopId;
	const sock = _sock;
	if (!shopId || !sock || _snapshot.state !== "open") return;
	return outbox.flush(shopId, async ({ id, jid, text }) => {
		if (_shopId !== shopId || _sock !== sock || _snapshot.state !== "open") return false;
		try {
			const sent = await sock.sendMessage(jid, { text });
			console.log(`[WA] sent queued ${id} → ${jid} (${sent?.key?.id})`);
			return !!sent?.key?.id;
		} catch (error) {
			console.error(`[WA] queued ${id} → ${jid} failed:`, error.message);
			return false;
		}
	});
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

// Handler for the backend's "whatsappSend" SSE event: { id, to, text }. While
// WhatsApp isn't connected it waits in the outbox; ids already sent are
// skipped, so an SSE replay after a reconnect can't send the same text twice.
async function sendText(payload) {
	const { id, to, text } = payload || {};
	if (id != null && outbox.wasSent(String(id))) {
		console.log(`[WA] skipping duplicate send ${id}`);
		return;
	}

	const jid = toJid(to);
	if (!jid || typeof text !== "string" || !text) {
		console.error(`[WA] dropped send ${id}: invalid recipient or text`);
		return;
	}
	if (!_shopId) {
		console.error(`[WA] dropped send ${id}: no shop`);
		return;
	}
	const sendId = id != null ? String(id) : `send:${Date.now()}`;
	if (!_sock || _snapshot.state !== "open" || outbox.pendingCount(_shopId) > 0) {
		outbox.enqueue({ id: sendId, shopId: _shopId, jid, text });
		void _flushOutbox(); // a no-op until WhatsApp is connected
		return;
	}

	try {
		const sent = await _sock.sendMessage(jid, { text });
		outbox.markSent(sendId);
		console.log(`[WA] sent ${id} → ${jid} (${sent?.key?.id})`);
	} catch (error) {
		console.error(`[WA] send ${id} → ${jid} failed — queued:`, error.message);
		outbox.enqueue({ id: sendId, shopId: _shopId, jid, text });
	}
}

// The backend is reachable again (connectivity.onOnline). A socket waiting out
// its reconnect backoff goes now; queued sends go out, and customer messages
// waiting on the backend carry on.
function onOnline() {
	if (_shopId && !_sock && _retryTimer) {
		clearTimeout(_retryTimer);
		_retryTimer = null;
		_retryDelay = 2000;
		console.log("[WA] connection back — reconnecting now");
		void _connect();
	}
	void flushReadyNotifications();
	void _flushOutbox();
	_wakeWaiters();
	_replayInbound(_shopId);
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

module.exports = { start, connect, disconnect, unlink, onOnline, setEnabled, setFlow, addExcludedContact, removeExcludedContact, sendText, notifyJobReady, setJobActions, getSnapshot, setNotifier };
