const EventSource = require("eventsource");
const { getAuth, setAuth, setJobs, clearAuth } = require("./state");

// const API_BASE_URL = "https://clickprintbackend.wckd.pk"
const API_BASE_URL = "http://localhost:3000"

// The backend now nests each route's payload under a named key inside `data`
// (e.g. { data: { jobs: [...] } } instead of { data: [...] }). Unwrap that named
// key so callers keep receiving the bare value as `data`, matching the previous
// response shape. Untouched when the response failed or the key isn't present.
function unwrap(payload, key) {
	if (payload && payload.success && payload.data && typeof payload.data === "object" && key in payload.data) {
		return { ...payload, data: payload.data[key] };
	}
	return payload;
}

// Reads a response body as JSON without throwing. Gateways/proxies return HTML
// error pages (e.g. a 502 "<!DOCTYPE html>…") that would otherwise blow up
// JSON.parse — fall back to a clean failure object instead.
async function readJson(response) {
	const text = await response.text();
	try {
		return JSON.parse(text);
	} catch {
		console.error(`[API] non-JSON response (HTTP ${response.status})`);
		return { success: false, message: `Server error (HTTP ${response.status}). Please try again.` };
	}
}

async function sendOtp(number) {
	try {
		const response = await fetch(`${API_BASE_URL}/api/auth/otp`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ number, intent: "shop" }),
		});

		const data = await readJson(response);

		if (data.success) {
			setAuth({ phoneNumber: number });
		}

		return data;
	} catch (error) {
		console.error("[API] sendOtp error:", error);
		return {
			success: false,
			message:
				error.message === "fetch failed"
					? "Network error. Please check your internet connection."
					: "An unexpected error occurred. Please try again.",
		};
	}
}

async function verifyOtp(code, number) {
	try {
		const response = await fetch(`${API_BASE_URL}/api/auth/verify`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ code, number }),
		});

		const data = await readJson(response);

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
			console.log("[API] Auth token stored;", (data.data.shops?.length ?? 0), "shop(s) to choose from");
		}

		return data;
	} catch (error) {
		console.error("[API] verifyOtp error:", error);
		return {
			success: false,
			message:
				error.message === "fetch failed"
					? "Network error. Please check your internet connection."
					: "An unexpected error occurred. Please try again.",
		};
	}
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

async function fetchJobs() {
	try {
		const response = await fetch(`${API_BASE_URL}/api/jobs`, {
			headers: {
		"Content-Type": "application/json",
		Authorization: `Bearer ${getAuth().token}`,
	},
		});
		return unwrap(await readJson(response), "jobs");
	} catch (error) {
		console.error("[API] fetchJobs error:", error);
		return {
			success: false,
			message:
				error.message === "fetch failed"
					? "Network error. Please check your internet connection."
					: "An unexpected error occurred. Please try again.",
		};
	}
}

async function updateJobStatus(jobId, status) {
	try {
		const response = await fetch(`${API_BASE_URL}/api/jobs/${jobId}/status`, {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${getAuth().token}`,
			},
			body: JSON.stringify({ status }),
		});
		return unwrap(await readJson(response), "job");
	} catch (error) {
		console.error(`[API] updateJobStatus ${jobId} error:`, error);
		return { success: false };
	}
}

function getAuthState() {
	return getAuth();
}
function clearAuthState() {
	clearAuth();
}

// Jobs currently being transitioned to "failed". The backend only allows
// queued → printing → failed, so we must step through "printing" — but the UI
// must never show that intermediate state. Jobs flagged here are filtered out of
// every push to the renderer (see isJobFailing); the UI removes them via the
// explicit jobs:file-failed event instead.
const _failingJobs = new Set();

function isJobFailing(jobId) {
	return _failingJobs.has(jobId);
}

// Marks a job "failed" on the backend — used when one of its files can't be
// downloaded (even after a retry), or when every document in a job failed to
// print. Steps through the required "printing" status first; the renderer
// never sees it (the job is already flagged as failing). `currentStatus`, when
// known to already be "printing" (true for every print-failure caller, since
// the print attempt itself only happens after that transition), skips the step
// — some backends reject a redundant same-state transition, which would
// otherwise block the real "failed" transition from ever being attempted.
async function markJobFailed(jobId, currentStatus) {
	_failingJobs.add(jobId);
	if (currentStatus !== "printing") {
		const printing = await updateJobStatus(jobId, "printing");
		if (!printing?.success) {
			console.error(`[API] job ${jobId}: could not transition to printing —`, printing?.message);
			return printing;
		}
	}
	const result = await updateJobStatus(jobId, "failed");
	if (result?.success) console.log(`[API] job ${jobId} marked failed`);
	else console.error(`[API] job ${jobId}: could not transition to failed —`, result?.message);
	return result;
}

// Jobs arrive from the backend as "submitted". We acknowledge receipt of each
// one exactly once by moving it to "queued". The acked set guards against
// re-sending while a reconcile is in flight (before the new status is fetched).
const _acknowledgedJobs = new Set();

function acknowledgeNewJobs(jobs) {
	for (const job of jobs || []) {
		if (job.status !== "submitted" || _acknowledgedJobs.has(job._id)) continue;
		_acknowledgedJobs.add(job._id);
		updateJobStatus(job._id, "queued").then((result) => {
			if (result && result.success) {
				console.log(`[API] acknowledged job ${job._id} → queued`);
			} else {
				console.error(`[API] failed to acknowledge job ${job._id}, will retry`);
				_acknowledgedJobs.delete(job._id); // allow retry on next reconcile
			}
		});
	}
}

// Downloads the raw bytes of a single file. Returns the ArrayBuffer so the
// caller (files.js) can persist it to disk.
async function fetchFileBuffer(fileId) {
	try {
		console.log(`[API] fetchFileBuffer ${fileId}`);
		const response = await fetch(`${API_BASE_URL}/api/files/${fileId}`, {
			headers: { Authorization: `Bearer ${getAuth().token}` },
		});
		if (!response.ok) {
			console.error(`[API] fetchFileBuffer ${fileId} → HTTP ${response.status}`);
			return { ok: false };
		}
		const buffer = await response.arrayBuffer();
		return { ok: true, buffer, contentType: response.headers.get("content-type") };
	} catch (error) {
		console.error(`[API] fetchFileBuffer ${fileId} error:`, error);
		return { ok: false };
	}
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

function authHeaders() {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${getAuth().token}`,
	};
}

function apiError(error) {
	return {
		success: false,
		message:
			error.message === "fetch failed"
				? "Network error. Please check your internet connection."
				: "An unexpected error occurred. Please try again.",
	};
}

// ── Shop ──────────────────────────────────────────────────────────────────────

async function fetchShop() {
	const shopId = getShopId();
	if (!shopId) return { success: false, message: "Shop not identified." };
	try {
		const response = await fetch(`${API_BASE_URL}/api/shops/${shopId}`, {
			headers: authHeaders(),
		});
		return unwrap(await readJson(response), "shop");
	} catch (error) {
		console.error("[API] fetchShop error:", error);
		return apiError(error);
	}
}

// ── Shop services CRUD ────────────────────────────────────────────────────────
// A "service" is a priced print configuration: { rate, keys, printers }. These
// live under /api/services (the shop is resolved from the auth token).

async function fetchServices() {
	try {
		const response = await fetch(`${API_BASE_URL}/api/services`, {
			headers: authHeaders(),
		});
		return unwrap(await readJson(response), "services");
	} catch (error) {
		console.error("[API] fetchServices error:", error);
		return apiError(error);
	}
}

async function createService(service) {
	try {
		const response = await fetch(`${API_BASE_URL}/api/services`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify(service),
		});
		return unwrap(await readJson(response), "service");
	} catch (error) {
		console.error("[API] createService error:", error);
		return apiError(error);
	}
}

async function updateService(serviceId, service) {
	try {
		const response = await fetch(`${API_BASE_URL}/api/services/${serviceId}`, {
			method: "PUT",
			headers: authHeaders(),
			body: JSON.stringify(service),
		});
		return unwrap(await readJson(response), "service");
	} catch (error) {
		console.error("[API] updateService error:", error);
		return apiError(error);
	}
}

async function deleteService(serviceId) {
	try {
		const response = await fetch(`${API_BASE_URL}/api/services/${serviceId}`, {
			method: "DELETE",
			headers: authHeaders(),
		});
		return unwrap(await readJson(response), "service");
	} catch (error) {
		console.error("[API] deleteService error:", error);
		return apiError(error);
	}
}

// ── Shop printers CRUD ────────────────────────────────────────────────────────
// The printers a shop has registered with the backend. Distinct from the local
// OS printer list (printers.js), which only says what's reachable right now.

async function fetchPrinters() {
	try {
		const response = await fetch(`${API_BASE_URL}/api/printers`, {
			headers: authHeaders(),
		});
		return unwrap(await readJson(response), "printers");
	} catch (error) {
		console.error("[API] fetchPrinters error:", error);
		return apiError(error);
	}
}

async function createPrinter(name) {
	try {
		const response = await fetch(`${API_BASE_URL}/api/printers`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({ name }),
		});
		return unwrap(await readJson(response), "printer");
	} catch (error) {
		console.error("[API] createPrinter error:", error);
		return apiError(error);
	}
}

async function deletePrinter(printerId) {
	try {
		const response = await fetch(`${API_BASE_URL}/api/printers/${printerId}`, {
			method: "DELETE",
			headers: authHeaders(),
		});
		return unwrap(await readJson(response), "printer");
	} catch (error) {
		console.error("[API] deletePrinter error:", error);
		return apiError(error);
	}
}

async function fetchHistory() {
	try {
		const response = await fetch(`${API_BASE_URL}/api/history`, {
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${getAuth().token}`,
			},
		});
		return unwrap(await readJson(response), "history");
	} catch (error) {
		console.error("[API] fetchHistory error:", error);
		return {
			success: false,
			message:
				error.message === "fetch failed"
					? "Network error. Please check your internet connection."
					: "An unexpected error occurred. Please try again.",
		};
	}
}

async function updateShop(shopId, data) {
	try {
		const response = await fetch(`${API_BASE_URL}/api/shops/${shopId}`, {
			method: "PUT",
			headers: {
		"Content-Type": "application/json",
		Authorization: `Bearer ${getAuth().token}`,
	},
			body: JSON.stringify(data),
		});

		return unwrap(await readJson(response), "shop");
	} catch (error) {
		console.error("[API] updateShop error:", error);
		return {
			success: false,
			message:
				error.message === "fetch failed"
					? "Network error. Please check your internet connection."
					: "An unexpected error occurred. Please try again.",
		};
	}
}

async function pingShopStatus(shopId){
	try {
		const response = await fetch(`${API_BASE_URL}/api/shops/${shopId}/isOnline`, {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${getAuth().token}`,
			}
		});
		return await readJson(response);
	} 
	catch (error) {
		console.error("[API] pingShopStatus error:", error);
		return {
			success: false,
			message:
				error.message === "fetch failed"
					? "Network error. Please check your internet connection."
					: "An unexpected error occurred. Please try again.",
		};
	}
}

let _sse = null;
let _sseTimer = null;
let _onJobsUpdate = null;

// Connection state of the live jobs stream, surfaced to the renderer so the UI
// can show a healthy/reconnecting indicator. One of:
//   "connecting"   — opening the EventSource (initial or after a drop)
//   "open"         — connected and receiving
//   "reconnecting" — dropped; a retry is scheduled
//   "closed"       — intentionally stopped (logout / no shop selected)
let _sseStatus = "closed";
let _onSseStatus = null;

function setSseStatusNotifier(cb) {
	_onSseStatus = cb;
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

function startJobsSse(onJobsUpdate) {
	_onJobsUpdate = onJobsUpdate;
	_connectSse();
}

function stopJobsSse() {
	_onJobsUpdate = null;
	clearTimeout(_sseTimer);
	_sseTimer = null;
	_acknowledgedJobs.clear();
	if (_sse) {
		_sse.close();
		_sse = null;
	}
	_setSseStatus("closed");
}

function _connectSse() {
	if (!getAuth().token || !_onJobsUpdate) return;

	// The live jobs stream is scoped to the chosen shop: /api/events/:shopId.
	// Without a selected shop there's nothing to stream — bail (selectShop, which
	// runs before beginJobsSync, guarantees this is set for a normal login).
	const shopId = getShopId();
	if (!shopId) {
		console.warn("[SSE] no shop selected — not connecting");
		_setSseStatus("closed");
		return;
	}

	_setSseStatus("connecting");

	const endpoint = `${API_BASE_URL}/api/events/${shopId}`;

	_sse = new EventSource(endpoint, {
		headers: { Authorization: `Bearer ${getAuth().token}` },
	});

	_sse.onopen = () => {
		console.log("[SSE] Connected");
		_setSseStatus("open");
		_reconcile();
	};

	_sse.onmessage = (event) => {
		console.log("[SSE] Event:", event.data);
		_reconcile();
	};

	// named events need addEventListener, not onmessage
	_sse.addEventListener("jobsUpdate", (event) => {
		console.log("[SSE] jobsUpdate:", event.data);
		_reconcile();
	});

	_sse.addEventListener("ping", async () => {
		console.log("[SSE] ping");
		const shopId = getShopId();
		if (shopId) {
			const result = await pingShopStatus(shopId);
			if (result.success) {
				console.log("[SSE] ping successful");
			} else {
				console.error("[SSE] ping failed:", result.message);
			}
		}
	});

	_sse.onerror = (err) => {
		console.error("[SSE] Error:", err.message ?? err.type);
		_sse.close();
		_sse = null;
		if (_onJobsUpdate) {
			_setSseStatus("reconnecting");
			_sseTimer = setTimeout(_connectSse, 5000);
		} else {
			_setSseStatus("closed");
		}
	};
}

async function _reconcile() {
	if (!_onJobsUpdate) return;
	const result = await fetchJobs();
	console.log(`[SSE] Reconcile complete — ${result.success ? result.data?.length + " jobs" : "failed: " + result.message}`);
	if (result.success) {
		setJobs(result.data);
		_onJobsUpdate(result.data);
	}
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
	fetchPrinters,
	createPrinter,
	deletePrinter,
	fetchJobs,
	fetchHistory,
	fetchFileBuffer,
	updateJobStatus,
	markJobFailed,
	isJobFailing,
	acknowledgeNewJobs,
	startJobsSse,
	stopJobsSse,
	setSseStatusNotifier,
	getSseStatus,
};
