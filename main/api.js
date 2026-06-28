const EventSource = require("eventsource");
const { getAuth, setAuth, setJobs } = require("./state");

const API_BASE_URL = "http://192.168.200.254:3000"

async function sendOtp(number) {
	try {
		const response = await fetch(`${API_BASE_URL}/api/auth/otp`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ number }),
		});

		const data = await response.json();

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
			body: JSON.stringify({ code, number, actor: "shop" }),
		});

		const data = await response.json();

		if (data.success) {
			setAuth({
				token: data.data.token,
				profile: data.data.profile ?? null,
				shopId: data.data.shop?._id ?? data.data.profile?._id ?? null,
				phoneNumber: number,
			});
			console.log("[API] Auth token stored, shopId:", getAuth().shopId);
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

async function fetchJobs() {
	try {
		const response = await fetch(`${API_BASE_URL}/api/jobs`, {
			headers: {
		"Content-Type": "application/json",
		Authorization: `Bearer ${getAuth().token}`,
	},
		});
		return await response.json();
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

// Updates a job's status on the backend (e.g. acknowledging a new job).
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
		return await response.json();
	} catch (error) {
		console.error(`[API] updateJobStatus ${jobId} error:`, error);
		return { success: false };
	}
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
		return payload.shopId || payload.shop || payload._id || payload.sub || null;
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

// ── Shop pricing CRUD ─────────────────────────────────────────────────────────

async function fetchPrices() {
	const shopId = getShopId();
	if (!shopId) return { success: false, message: "Shop not identified." };
	try {
		const response = await fetch(`${API_BASE_URL}/api/shops/${shopId}`, {
			headers: authHeaders(),
		});
		return await response.json();
	} catch (error) {
		console.error("[API] fetchPrices error:", error);
		return apiError(error);
	}
}

async function createPrice(price) {
	const shopId = getShopId();
	if (!shopId) return { success: false, message: "Shop not identified." };
	try {
		const response = await fetch(`${API_BASE_URL}/api/shops/${shopId}/prices`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify(price),
		});
		return await response.json();
	} catch (error) {
		console.error("[API] createPrice error:", error);
		return apiError(error);
	}
}

async function updatePrice(priceId, price) {
	const shopId = getShopId();
	if (!shopId) return { success: false, message: "Shop not identified." };
	try {
		const response = await fetch(`${API_BASE_URL}/api/shops/${shopId}/prices/${priceId}`, {
			method: "PUT",
			headers: authHeaders(),
			body: JSON.stringify(price),
		});
		return await response.json();
	} catch (error) {
		console.error("[API] updatePrice error:", error);
		return apiError(error);
	}
}

async function deletePrice(priceId) {
	const shopId = getShopId();
	if (!shopId) return { success: false, message: "Shop not identified." };
	try {
		const response = await fetch(`${API_BASE_URL}/api/shops/${shopId}/prices/${priceId}`, {
			method: "DELETE",
			headers: authHeaders(),
		});
		return await response.json();
	} catch (error) {
		console.error("[API] deletePrice error:", error);
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
		return await response.json();
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

		return await response.json();
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

let _sse = null;
let _sseTimer = null;
let _onJobsUpdate = null;

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
}

function _connectSse() {
	if (!getAuth().token || !_onJobsUpdate) return;

	const endpoint = `${API_BASE_URL}/events`;

	_sse = new EventSource(endpoint, {
		headers: { Authorization: `Bearer ${getAuth().token}` },
	});

	_sse.onopen = () => {
		console.log("[SSE] Connected");
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

	_sse.onerror = (err) => {
		console.error("[SSE] Error:", err.message ?? err.type);
		_sse.close();
		_sse = null;
		if (_onJobsUpdate) {
			_sseTimer = setTimeout(_connectSse, 5000);
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
	updateShop,
	fetchPrices,
	createPrice,
	updatePrice,
	deletePrice,
	fetchJobs,
	fetchHistory,
	fetchFileBuffer,
	updateJobStatus,
	acknowledgeNewJobs,
	startJobsSse,
	stopJobsSse,
};
