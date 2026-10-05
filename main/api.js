const fs = require("fs");
const path = require("path");
const EventSource = require("eventsource");
const tus = require("tus-js-client");
const { app, BrowserWindow } = require("electron");
const { getAuth, setAuth, setJobs, clearAuth } = require("./state");
const { listPrinters } = require("./printers");
const { request, requestStream, unwrap, baseUrl, getFault } = require("./http");
const connectivity = require("./connectivity");
const { createResourceCache, readThrough } = require("./resourceCache");
const historyCache = require("./historyCache");

// Every backend route the app uses. Requests go through http.js (timeouts,
// failure kinds, connectivity reporting). Reads of shop-scoped resources are
// read-through cached: a fresh result is saved, and a failed one falls back to
// the last good copy marked `stale` — so screens, routing and WhatsApp keep
// working from it while the backend can't be reached.

const caches = {
	jobs: createResourceCache("jobs-cache"),
	shop: createResourceCache("shop-cache"),
	services: createResourceCache("services-cache"),
	printers: createResourceCache("printers-cache"),
	history: historyCache,
};

function authHeaders() {
	return { Authorization: `Bearer ${getAuth().token}` };
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function sendOtp(number) {
	const data = await request("POST", "/api/auth/otp", { body: { number, intent: "shop" } });
	if (data.success) setAuth({ phoneNumber: number });
	return data;
}

async function verifyOtp(code, number) {
	const data = await request("POST", "/api/auth/verify", { body: { code, number } });
	if (data.success) {
		// A user can own multiple shops, returned in data.data.shops as
		// [{ _id, name }]. We don't know which one yet — the renderer picks one
		// (or auto-picks when there's a single shop) and calls selectShop, which
		// is what actually stores shopId and opens the shop-scoped SSE stream.
		setAuth({
			token: data.data.token,
			profile: data.data.profile ?? null,
			phoneNumber: number,
			shopId: null,
			shopName: null,
		});
		connectivity.clearAuthExpired();
		console.log("[API] Auth token stored;", (data.data.shops?.length ?? 0), "shop(s) to choose from");
	}
	return data;
}

// Records which shop the user chose to operate as for this session. Everything
// shop-scoped (jobs SSE, shop/services/printers fetches, isOnline ping) resolves
// its shop id from here via getShopId.
function selectShop(shop) {
	if (!shop || !shop._id) return { success: false, message: "No shop selected." };
	setAuth({ shopId: shop._id, shopName: shop.name ?? null });
	console.log("[API] shop selected:", shop._id, shop.name);
	return { success: true };
}

function getAuthState() {
	return getAuth();
}
function clearAuthState() {
	clearAuth();
}

// Resolves the shop id, preferring the value saved at verify time and falling
// back to decoding it out of the JWT payload.
function getShopId() {
	const auth = getAuth();
	if (auth.shopId) return auth.shopId;
	if (!auth.token) return null;
	try {
		const payload = JSON.parse(Buffer.from(auth.token.split(".")[1], "base64").toString("utf8"));
		return payload.shopId || payload.sid || payload.shop || payload._id || payload.sub || null;
	} catch {
		return null;
	}
}

// ── Cached reads ──────────────────────────────────────────────────────────────

// GET with one retry, read through `cache`: { ...fresh } or { ...cached, stale }.
async function cachedGet(path, key, cache, label) {
	const result = unwrap(await request("GET", path, { headers: authHeaders(), retries: 1 }), key);
	return readThrough(cache, getShopId(), result, label);
}

// The cached copy alone (no request), or null — for callers that only want to
// avoid a round trip, e.g. WhatsApp replies while offline.
function cachedCopy(resource) {
	return caches[resource]?.load(getShopId()) ?? null;
}

function cachedData(resource) {
	return cachedCopy(resource)?.data ?? null;
}

function clearCaches() {
	return Promise.all(Object.values(caches).map((cache) => cache.clear()));
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

function fetchJobs() {
	return cachedGet(`/api/jobs/shop/${getShopId()}`, "jobs", caches.jobs, "fetchJobs");
}

function fetchHistory() {
	return cachedGet(`/api/history/shops/${getShopId()}`, "history", caches.history, "fetchHistory");
}

// Wired by ipc.js: persist the outgoing message without importing whatsapp.js,
// which already imports this module for uploads and drafts.
let _onJobCompleted = null;
function setJobCompletedHandler(cb) {
	_onJobCompleted = cb;
}

// One status transition. Not retried here — a status the backend never saw is
// replayed by the outbox (statusOutbox.js), and repeating a transition that did
// land would be rejected as a same-state change.
async function updateJobStatus(jobId, status) {
	const result = unwrap(
		await request("PATCH", `/api/jobs/${jobId}/status`, { headers: authHeaders(), body: { status } }),
		"job"
	);
	if (result.success && status === "completed" && result.data?.status === "completed" && _onJobCompleted) {
		try {
			_onJobCompleted(result.data);
		} catch (error) {
			// A notification failure must not undo a successful status update.
			console.error(`[API] job ${jobId} completion notification failed:`, error.message);
		}
	}
	if (!result.success) console.error(`[API] updateJobStatus ${jobId} → ${status} failed (${result.kind}):`, result.message);
	return result;
}

// Jobs currently being transitioned to "failed". The backend only allows
// queued → printing → failed, so we must step through "printing" — but the UI
// must never show that intermediate state. Jobs flagged here are filtered out of
// every push to the renderer (see isJobFailing); the print engine's status
// override + toast event inform the UI instead.
const _failingJobs = new Set();

function isJobFailing(jobId) {
	return _failingJobs.has(jobId);
}

// Marks a job "failed" on the backend — only ever the operator's explicit
// decision (it refunds the customer). Steps through the required "printing"
// status first; the renderer never sees it (the job is already flagged as
// failing). `currentStatus`, when known to already be "printing", skips the step
// — some backends reject a redundant same-state transition, which would
// otherwise block the real "failed" transition from ever being attempted.
async function markJobFailed(jobId, currentStatus) {
	_failingJobs.add(jobId);
	if (currentStatus !== "printing") {
		const printing = await updateJobStatus(jobId, "printing");
		if (!printing?.success) {
			console.error(`[API] job ${jobId}: could not transition to printing —`, printing?.message);
			// Un-hide it: the job is NOT failing after all. Leaving the flag set
			// would filter it out of every renderer push until the app restarts,
			// stranding the operator with no control to retry from.
			_failingJobs.delete(jobId);
			return printing;
		}
	}
	const result = await updateJobStatus(jobId, "failed");
	if (result?.success) {
		console.log(`[API] job ${jobId} marked failed`);
	} else {
		console.error(`[API] job ${jobId}: could not transition to failed —`, result?.message);
		// Same reasoning: the job stays visible so it can be retried.
		_failingJobs.delete(jobId);
	}
	return result;
}

// ── Files ─────────────────────────────────────────────────────────────────────

// Opens a download of a single file: { ok, response, status } once headers
// arrive, or a failure ({ ok: false, kind, status, offline, retryable }). The
// caller (files.js) streams the body with its own stall detection. `accept`
// asks for a specific format — job files pass "application/pdf" so they come
// back converted rather than as the raw upload; payment proofs omit it and get
// the original. `range` resumes from a byte offset.
function openFileDownload(fileId, { accept, range, controller } = {}) {
	const headers = authHeaders();
	if (accept) headers.Accept = accept;
	if (range) headers.Range = `bytes=${range}-`;
	return requestStream(`/api/files/${fileId}`, { headers, controller });
}

// Where tus remembers half-finished uploads, so a retry after the link dropped
// — even after a restart — continues from the last byte the server has
// instead of starting over. Absent outside Electron (tests).
function tusUrlStorage() {
	try {
		return app?.getPath ? new tus.FileUrlStorage(path.join(app.getPath("userData"), "tus-uploads.json")) : null;
	} catch {
		return null;
	}
}

// Uploads a file on disk to /api/files over tus. The request carrying the last
// byte only returns once the backend has converted the file to PDF, so there is
// no timeout. Resolves { success: true, data: file } with the backend's File
// object, or { success: false, status, message } — status is the HTTP status of
// the failing tus request, undefined when the server was never reached.
// Network errors and 5xx are retried for about two minutes (resuming each
// time); after that the caller parks the file and tries again later.
function uploadFile(filePath, { filename, filetype }) {
	return new Promise((resolve) => {
		const urlStorage = tusUrlStorage();
		const upload = new tus.Upload(fs.createReadStream(filePath), {
			endpoint: `${baseUrl()}/api/files`,
			headers: authHeaders(),
			metadata: { filename, filetype: filetype || "application/octet-stream" },
			chunkSize: 5 * 1024 * 1024,
			// tus only retries network errors and 5xx; 4xx (413, 422, …) fail at once.
			retryDelays: [0, 1000, 3000, 5000, 10000, 15000, 30000, 60000],
			...(urlStorage && { urlStorage, storeFingerprintForResuming: true, removeFingerprintOnSuccess: true }),
			onSuccess: ({ lastResponse }) => {
				let body = null;
				try {
					body = JSON.parse(lastResponse.getBody());
				} catch {}
				const file = body?.data?.file;
				if (file) {
					console.log(`[API] uploadFile ${filename} → ${file._id}`);
					resolve({ success: true, data: file });
				} else {
					console.error(`[API] uploadFile ${filename}: unexpected response`, lastResponse.getBody());
					resolve({ success: false, status: lastResponse.getStatus(), message: "Unexpected response from server." });
				}
			},
			onError: (error) => {
				const response = error.originalResponse;
				const status = response ? response.getStatus() : undefined;
				let message = "Upload failed";
				try {
					message = JSON.parse(response.getBody()).message || message;
				} catch {}
				console.error(`[API] uploadFile ${filename} failed (HTTP ${status ?? "—"}):`, message, error.message);
				resolve({ success: false, status, message });
			},
		});
		if (!urlStorage) {
			upload.start();
			return;
		}
		upload
			.findPreviousUploads()
			.then((previous) => {
				if (previous.length) {
					console.log(`[API] uploadFile ${filename}: resuming an earlier upload`);
					upload.resumeFromPreviousUpload(previous[0]);
				}
			})
			.catch(() => {})
			.finally(() => upload.start());
	});
}

// ── Shop ──────────────────────────────────────────────────────────────────────

function fetchShop() {
	const shopId = getShopId();
	if (!shopId) return Promise.resolve({ success: false, message: "Shop not identified." });
	return cachedGet(`/api/shops/${shopId}`, "shop", caches.shop, "fetchShop");
}

async function updateShop(shopId, data) {
	const result = unwrap(await request("PUT", `/api/shops/${shopId}`, { headers: authHeaders(), body: data }), "shop");
	if (result.success && result.data) caches.shop.save(shopId, result.data);
	return result;
}

// Reports which of the shop's registered printers this machine can reach right
// now. Fired on every SSE ping; a ping that lands while the previous one is
// still in flight is skipped, so a slow link can't stack them up.
let _pingBusy = false;
async function pingShopStatus(shopId) {
	if (_pingBusy) return { success: true, skipped: true };
	_pingBusy = true;
	try {
		const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
		const localPrinters = win ? await listPrinters(win) : [];
		const onlineNames = new Set(localPrinters.map((p) => p.name));

		const registeredRes = await fetchPrinters();
		const registeredPrinters = registeredRes?.success && Array.isArray(registeredRes.data) ? registeredRes.data : [];
		const onlinePrinterIds = registeredPrinters.filter((p) => onlineNames.has(p.name)).map((p) => p._id);

		return await request("PATCH", `/api/shops/${shopId}/isOnline`, {
			headers: authHeaders(),
			body: { printers: onlinePrinterIds },
			timeoutMs: 10000,
		});
	} catch (error) {
		console.error("[API] pingShopStatus error:", error);
		return { success: false, message: error.message };
	} finally {
		_pingBusy = false;
	}
}

// ── Shop services CRUD ────────────────────────────────────────────────────────
// A "service" is a priced print configuration: { rate, keys, printers }. These
// live under /api/services/:shopId.

function fetchServices() {
	return cachedGet(`/api/services/${getShopId()}`, "services", caches.services, "fetchServices");
}

async function serviceRequest(method, suffix, body) {
	return unwrap(await request(method, `/api/services/${getShopId()}${suffix}`, { headers: authHeaders(), body }), "service");
}

const createService = (service) => serviceRequest("POST", "", service);
const updateService = (serviceId, service) => serviceRequest("PUT", `/${serviceId}`, service);
const deleteService = (serviceId) => serviceRequest("DELETE", `/${serviceId}`);
const setServiceDisabled = (serviceId, isDisabled) => serviceRequest("PATCH", `/${serviceId}/isDisabled`, { isDisabled });

// ── Shop printers CRUD ────────────────────────────────────────────────────────
// The printers a shop has registered with the backend. Distinct from the local
// OS printer list (printers.js), which only says what's reachable right now.

function fetchPrinters() {
	return cachedGet(`/api/printers/${getShopId()}`, "printers", caches.printers, "fetchPrinters");
}

async function printerRequest(method, suffix, body) {
	return unwrap(await request(method, `/api/printers/${getShopId()}${suffix}`, { headers: authHeaders(), body }), "printer");
}

const createPrinter = (name) => printerRequest("POST", "", { name });
const deletePrinter = (printerId) => printerRequest("DELETE", `/${printerId}`);
const setPrinterDisabled = (printerId, isDisabled) => printerRequest("PATCH", `/${printerId}/isDisabled`, { isDisabled });

// ── Drafts (WhatsApp orders) ──────────────────────────────────────────────────
// Each resolves the usual { success, message, data } plus the HTTP `status`, so
// callers can tell a draft that no longer exists (404) from other failures, and
// `offline` when the backend couldn't be reached. `data` is the draft, or the
// job it became for submit.

// Updating, pricing and deleting a draft are safe to repeat, so a dropped
// request is retried once; creating and submitting are not (a repeat could
// make a second draft or order).
async function draftRequest(method, route, body, key) {
	const repeatable = method !== "POST" && !route.endsWith("/submit");
	return unwrap(
		await request(method, `/api/drafts${route}`, { headers: authHeaders(), body: body ?? undefined, retries: repeatable ? 1 : 0 }),
		key
	);
}

function createDraft(draft) {
	return draftRequest("POST", "", draft, "draft");
}

function updateDraft(draftId, draft) {
	return draftRequest("PUT", `/${draftId}`, draft, "draft");
}

// Prices the draft without submitting it.
function checkDraft(draftId) {
	return draftRequest("PATCH", `/${draftId}/check`, null, "draft");
}

// Turns the draft into a job; the backend deletes the draft.
function submitDraft(draftId) {
	return draftRequest("PATCH", `/${draftId}/submit`, null, "job");
}

function deleteDraft(draftId) {
	return draftRequest("DELETE", `/${draftId}`, null, "draft");
}

// ── Inference (WhatsApp AI chat flow) ─────────────────────────────────────────

// Asks the backend to read a customer's message about their order. `body` is
// { shop, message, files, history }; the backend owns the prompt. Resolves the
// usual shape plus `status`, with `data` the result { intent, language,
// changes, question }. The backend gives up on the model after 20s.
async function inferSettings(body) {
	return unwrap(await request("POST", "/api/webhooks/inference", { headers: authHeaders(), body, timeoutMs: 25000 }), "result");
}

// ── Live jobs stream (SSE) ────────────────────────────────────────────────────

// No event for this long means the stream is dead even if the socket never said
// so — a dropped Wi-Fi link leaves a half-open TCP connection that can sit
// "open" for many minutes. The backend pings every ~5 s.
const SSE_STALE_MS = 25000;
const SSE_MIN_DELAY_MS = 1000;
const SSE_MAX_DELAY_MS = 30000;

let _sse = null;
let _sseTimer = null;
let _sseWatchdog = null;
let _sseDelay = SSE_MIN_DELAY_MS;
let _sseLastEventAt = 0;
let _onJobsUpdate = null;

// Connection state of the live jobs stream, surfaced to the renderer. One of:
//   "connecting"   — opening the EventSource (initial or after a drop)
//   "open"         — connected and receiving
//   "reconnecting" — dropped; a retry is scheduled
//   "closed"       — intentionally stopped (logout / no shop selected)
let _sseStatus = "closed";
let _onSseStatus = null;

// Fired on every SSE "ping" (~5s). The print engine hangs its printer-queue
// reconcile off this. Set by ipc.js; api.js must not import the engine (the
// engine imports api).
let _onPing = null;
let _pingHandlerBusy = false;

// Fired on every "whatsappSend" SSE event with its parsed payload
// ({ id, to, text }). Set by ipc.js; api.js must not import whatsapp.js (it
// imports api for uploads and drafts).
let _onWhatsAppSend = null;

function setSseStatusNotifier(cb) {
	_onSseStatus = cb;
}

function setPingNotifier(cb) {
	_onPing = cb;
}

function setWhatsAppSendHandler(cb) {
	_onWhatsAppSend = cb;
}

function getSseStatus() {
	return _sseStatus;
}

function _setSseStatus(status) {
	if (_sseStatus === status) return;
	_sseStatus = status;
	console.log("[SSE] status:", status);
	if (_onSseStatus) _onSseStatus(status);
}

// onJobsUpdate(jobs) on every fresh job list from the backend.
function startJobsSse(onJobsUpdate) {
	_onJobsUpdate = onJobsUpdate;
	_sseDelay = SSE_MIN_DELAY_MS;
	if (!_sseWatchdog) {
		_sseWatchdog = setInterval(_checkSseAlive, 5000);
		_sseWatchdog.unref?.();
	}
	_connectSse();
}

function stopJobsSse() {
	_onJobsUpdate = null;
	clearTimeout(_sseTimer);
	_sseTimer = null;
	clearInterval(_sseWatchdog);
	_sseWatchdog = null;
	_dropSse();
	_setSseStatus("closed");
}

// Closes the current EventSource without letting its handlers fire again.
function _dropSse() {
	const es = _sse;
	_sse = null;
	if (!es) return;
	es.onopen = es.onmessage = es.onerror = null;
	try {
		es.close();
	} catch {}
}

function _scheduleReconnect() {
	_dropSse();
	if (!_onJobsUpdate) {
		_setSseStatus("closed");
		return;
	}
	_setSseStatus("reconnecting");
	clearTimeout(_sseTimer);
	const delay = Math.round(_sseDelay * (0.5 + Math.random() * 0.5));
	_sseDelay = Math.min(_sseDelay * 2, SSE_MAX_DELAY_MS);
	_sseTimer = setTimeout(_connectSse, delay);
}

// The watchdog: a stream (or a connect attempt) that has gone silent is torn
// down and reconnected.
function _checkSseAlive() {
	if (!_sse || !_onJobsUpdate) return;
	const silentFor = Date.now() - _sseLastEventAt;
	if (silentFor < SSE_STALE_MS) return;
	console.warn(`[SSE] no events for ${Math.round(silentFor / 1000)}s — reconnecting`);
	connectivity.reportFailure();
	_scheduleReconnect();
}

// The connection is back (connectivity.onOnline) or the operator asked for a
// refresh: reconnect at once if the stream is down, otherwise re-fetch jobs.
function resync() {
	if (!_onJobsUpdate) return;
	if (_sseStatus === "open" && _sse) {
		_reconcile();
		return;
	}
	clearTimeout(_sseTimer);
	_sseTimer = null;
	_sseDelay = SSE_MIN_DELAY_MS;
	_dropSse();
	_connectSse();
}

function _connectSse() {
	_sseTimer = null;
	if (!getAuth().token || !_onJobsUpdate) return;

	// The live jobs stream is scoped to the chosen shop: /api/events/shop/:shopId.
	// Without a selected shop there's nothing to stream — bail (selectShop, which
	// runs before beginJobsSync, guarantees this is set for a normal login).
	const shopId = getShopId();
	if (!shopId) {
		console.warn("[SSE] no shop selected — not connecting");
		_setSseStatus("closed");
		return;
	}

	_dropSse();
	_setSseStatus(_sseStatus === "reconnecting" ? "reconnecting" : "connecting");
	_sseLastEventAt = Date.now(); // the connect attempt itself is watched too

	// Simulated outage (CLICKPRINT_NET_FAULT=offline, see http.js): the stream
	// can't connect either.
	if (getFault().offline) {
		console.warn("[SSE] connect blocked by injected fault");
		connectivity.reportFailure();
		_scheduleReconnect();
		return;
	}

	const es = new EventSource(`${baseUrl()}/api/events/shop/${shopId}`, {
		headers: { Authorization: `Bearer ${getAuth().token}` },
	});
	_sse = es;
	const current = () => es === _sse;
	const touch = () => {
		_sseLastEventAt = Date.now();
	};

	es.onopen = () => {
		if (!current()) return;
		console.log("[SSE] Connected");
		touch();
		_sseDelay = SSE_MIN_DELAY_MS;
		connectivity.reportSuccess();
		_setSseStatus("open");
		_reconcile();
	};

	es.onmessage = (event) => {
		if (!current()) return;
		touch();
		console.log("[SSE] Event:", event.data);
		_reconcile();
	};

	// named events need addEventListener, not onmessage
	es.addEventListener("jobsUpdate", (event) => {
		if (!current()) return;
		touch();
		console.log("[SSE] jobsUpdate:", event.data);
		_reconcile();
	});

	// The backend asking to send a WhatsApp text from the shop's linked number.
	es.addEventListener("whatsappSend", (event) => {
		if (!current()) return;
		touch();
		let payload;
		try {
			payload = JSON.parse(event.data);
		} catch {
			console.error("[SSE] whatsappSend: invalid JSON:", event.data);
			return;
		}
		console.log("[SSE] whatsappSend:", payload?.id, "→", payload?.to);
		if (_onWhatsAppSend) _onWhatsAppSend(payload);
	});

	es.addEventListener("ping", async () => {
		if (!current()) return;
		touch();
		// A slow beat (PowerShell queue sweep, a slow PATCH) must not stack up
		// behind the next one.
		if (_pingHandlerBusy) return;
		_pingHandlerBusy = true;
		try {
			// Sweep every printer's spool queue on the same beat: documents that have
			// finished (or died) leave the registry, foreign load is re-counted.
			if (_onPing) {
				try {
					await _onPing();
				} catch (err) {
					console.error("[SSE] ping handler error:", err.message);
				}
			}
			const id = getShopId();
			if (id) {
				const result = await pingShopStatus(id);
				if (!result.success) console.error("[SSE] ping failed:", result.message);
			}
		} finally {
			_pingHandlerBusy = false;
		}
	});

	es.onerror = (err) => {
		if (!current()) return;
		console.error("[SSE] Error:", err?.message ?? err?.type, err?.status ?? "");
		if (err?.status === 401) connectivity.report({ kind: "auth", status: 401 });
		else connectivity.reportFailure();
		_scheduleReconnect();
	};
}

// Re-fetches the job list. Coalesced: while one fetch is in flight, any number
// of further events cause exactly one follow-up fetch.
let _reconciling = null;
let _reconcileAgain = false;

function _reconcile() {
	if (!_onJobsUpdate) return Promise.resolve();
	if (_reconciling) {
		_reconcileAgain = true;
		return _reconciling;
	}
	_reconciling = (async () => {
		do {
			_reconcileAgain = false;
			const result = await fetchJobs();
			// A stale (cached) list is not news — only a fresh one drives the engine.
			if (result.success && !result.stale && _onJobsUpdate) {
				console.log(`[SSE] Reconcile complete — ${result.data?.length} jobs`);
				setJobs(result.data);
				_onJobsUpdate(result.data);
			} else if (!result.success || result.stale) {
				console.warn(`[SSE] Reconcile failed: ${result.message}`);
			}
		} while (_reconcileAgain && _onJobsUpdate);
	})().finally(() => {
		_reconciling = null;
	});
	return _reconciling;
}

module.exports = {
	sendOtp,
	verifyOtp,
	selectShop,
	getAuthState,
	clearAuthState,
	updateShop,
	fetchShop,
	fetchServices,
	createService,
	updateService,
	deleteService,
	setServiceDisabled,
	fetchPrinters,
	createPrinter,
	deletePrinter,
	setPrinterDisabled,
	fetchJobs,
	fetchHistory,
	cachedCopy,
	cachedData,
	clearCaches,
	openFileDownload,
	uploadFile,
	updateJobStatus,
	markJobFailed,
	isJobFailing,
	startJobsSse,
	stopJobsSse,
	resync,
	setSseStatusNotifier,
	setPingNotifier,
	setWhatsAppSendHandler,
	setJobCompletedHandler,
	getSseStatus,
	getShopId,
	createDraft,
	updateDraft,
	checkDraft,
	submitDraft,
	deleteDraft,
	inferSettings,
};
