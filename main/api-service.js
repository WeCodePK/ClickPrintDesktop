/**
 * API Service — all HTTP requests to the ClickPrint backend happen here,
 * inside the Electron main process. The renderer never makes direct API calls.
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");

const API_BASE_URL = "http://192.168.200.254:3000/api";

// ──────────── In-memory auth state ────────────
let authState = {
	token: null,
	profile: null,
	phoneNumber: null,
};

// ──────────── Helpers ────────────

function getAuthState() {
	return { ...authState };
}

function clearAuthState() {
	authState = { token: null, profile: null, phoneNumber: null };
}

function authHeaders() {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${authState.token}`,
	};
}

// ──────────── Auth API ────────────

async function sendOtp(number) {
	try {
		const response = await fetch(`${API_BASE_URL}/auth/otp`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ number }),
		});

		const data = await response.json();

		if (data.success) {
			authState.phoneNumber = number;
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
		const response = await fetch(`${API_BASE_URL}/auth/verify`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ code, number, actor: "shop" }),
		});

		const data = await response.json();

		if (data.success) {
			authState.token = data.data.token;
			authState.profile = data.data.profile || null;
			authState.phoneNumber = number;
			console.log("[API] Auth token stored in main process");
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

// ──────────── Jobs API ────────────

async function fetchJobs() {
	try {
		const response = await fetch(`${API_BASE_URL}/jobs`, {
			headers: authHeaders(),
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

// ──────────── SSE Connection (reconcile-on-connect pattern) ────────────
// SSE events are treated as invalidation hints — the server's REST API
// is the single source of truth. On every connect or event we re-fetch
// the full job list so missed events never leave the app in a stale state.

let _sseReq = null;
let _sseBackoff = 1000;
let _sseTimer = null;
let _onJobsUpdate = null;

function startJobsSse(onJobsUpdate) {
	_onJobsUpdate = onJobsUpdate;
	_sseBackoff = 1000;
	_connectSse();
}

function stopJobsSse() {
	_onJobsUpdate = null;
	clearTimeout(_sseTimer);
	_sseTimer = null;
	if (_sseReq) {
		_sseReq.destroy();
		_sseReq = null;
	}
}

function _connectSse() {
	if (!authState.token || !_onJobsUpdate) return;

	const endpoint = `${API_BASE_URL.replace(/\/api$/, "")}/events`;
	const parsed = new URL(endpoint);
	const transport = parsed.protocol === "https:" ? https : http;

	const req = transport.get(
		{
			hostname: parsed.hostname,
			port: parseInt(parsed.port) || (parsed.protocol === "https:" ? 443 : 80),
			path: parsed.pathname,
			headers: {
				Accept: "text/event-stream",
				"Cache-Control": "no-cache",
				Authorization: `Bearer ${authState.token}`,
			},
		},
		async (res) => {
			console.log(`[SSE] Connected — HTTP ${res.statusCode}`);

			// Non-200 means auth failure, wrong path, etc. — drain body and back off.
			if (res.statusCode !== 200) {
				let body = "";
				res.on("data", (c) => { body += c; });
				res.on("end", () => {
					console.error(`[SSE] Non-200 response (${res.statusCode}):`, body.slice(0, 200));
					_scheduleReconnect();
				});
				return;
			}

			// Reset backoff only after the connection has been alive for 5 seconds,
			// so a server that drops connections immediately doesn't defeat the backoff.
			const stabilityTimer = setTimeout(() => { _sseBackoff = 1000; }, 5000);

			// Always reconcile on (re)connect — catches any events missed while offline
			await _reconcile();

			let buf = "";
			res.on("data", (chunk) => {
				const raw = chunk.toString();
				console.log("[SSE] Raw chunk:", JSON.stringify(raw));
				buf += raw;
				// Normalise \r\n to \n so both line-ending styles work
				const lines = buf.replace(/\r\n/g, "\n").split("\n");
				buf = lines.pop(); // keep incomplete trailing line in buffer

				for (const line of lines) {
					if (line.startsWith("data: ")) {
						try {
							const event = JSON.parse(line.slice(6));
							console.log("[SSE] Parsed event:", event);
						} catch { /* ignore malformed */ }
						console.log("[SSE] Triggering reconcile");
						_reconcile();
					}
				}
			});

			res.on("end", () => {
				clearTimeout(stabilityTimer);
				console.log("[SSE] Connection ended, scheduling reconnect");
				_scheduleReconnect();
			});

			res.on("error", (err) => {
				clearTimeout(stabilityTimer);
				console.error("[SSE] Response error:", err.message);
				_scheduleReconnect();
			});
		}
	);

	req.on("error", (err) => {
		console.error("[SSE] Request error:", err.message);
		_scheduleReconnect();
	});

	_sseReq = req;
}

async function _reconcile() {
	if (!_onJobsUpdate) return;
	const result = await fetchJobs();
	console.log(`[SSE] Reconcile complete — ${result.success ? result.data?.length + " jobs" : "failed: " + result.message}`);
	if (result.success) {
		_onJobsUpdate(result.data);
	}
}

function _scheduleReconnect() {
	_sseReq = null;
	if (!_onJobsUpdate) return;
	console.log(`[SSE] Reconnecting in ${_sseBackoff}ms`);
	_sseTimer = setTimeout(() => {
		_sseBackoff = Math.min(_sseBackoff * 2, 30000);
		_connectSse();
	}, _sseBackoff);
}

// ──────────── Shop API ────────────

async function updateShop(shopId, data) {
	try {
		const response = await fetch(`${API_BASE_URL}/shops/${shopId}`, {
			method: "PUT",
			headers: authHeaders(),
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

module.exports = {
	sendOtp,
	verifyOtp,
	updateShop,
	getAuthState,
	clearAuthState,
	fetchJobs,
	startJobsSse,
	stopJobsSse,
};
