// The one door to the ClickPrint backend. Every REST call goes through
// request(): it bounds each call with a timeout (a choppy link otherwise leaves
// fetch hanging for minutes), sorts every failure into a kind, optionally
// retries the ones worth retrying, and reports each outcome to listeners — the
// connectivity tracker (connectivity.js) decides online/offline from them.
//
// Results keep the backend's { success, message, data } shape, plus:
//   status    — HTTP status, undefined when the server was never reached
//   kind      — "ok" | "http" | "auth" (401) | "server" (5xx) | "network" | "timeout"
//   offline   — true for "network" / "timeout": the server couldn't be reached
//   retryable — true when trying again later could succeed (offline or 5xx)
//
// No Electron imports, so it runs under plain `node --test`.

let API_BASE_URL = "https://api.clickprint.pk";

// Tests point requests at a local server.
function setBaseUrl(url) {
	API_BASE_URL = url;
}

function baseUrl() {
	return API_BASE_URL;
}

const DEFAULT_GET_TIMEOUT_MS = 15000;
const DEFAULT_WRITE_TIMEOUT_MS = 20000;

const OFFLINE_MESSAGE = "Network error. Please check your internet connection.";
const TIMEOUT_MESSAGE = "The connection timed out. Please check your internet connection.";

// ── outcome listeners ─────────────────────────────────────────────────────────

const _listeners = [];

// fn({ kind, status, method, path }) after every request attempt.
function onOutcome(fn) {
	_listeners.push(fn);
	return () => {
		const i = _listeners.indexOf(fn);
		if (i >= 0) _listeners.splice(i, 1);
	};
}

function _report(outcome) {
	for (const fn of _listeners) {
		try {
			fn(outcome);
		} catch (error) {
			console.error("[HTTP] outcome listener error:", error.message);
		}
	}
}

// ── fault injection (testing on a good network) ───────────────────────────────
// CLICKPRINT_NET_FAULT="offline" fails every request as unreachable;
// "flaky:0.5" fails half of them; "latency:4000" delays each by 4 s. Combine
// with commas: "flaky:0.3,latency:2000".

let _fault = parseFault(process.env.CLICKPRINT_NET_FAULT);

function parseFault(spec) {
	const fault = { offline: false, flaky: 0, latency: 0 };
	for (const part of String(spec || "").split(",")) {
		const [name, value] = part.trim().split(":");
		if (name === "offline") fault.offline = true;
		else if (name === "flaky") fault.flaky = Math.min(1, Math.max(0, Number(value) || 0));
		else if (name === "latency") fault.latency = Math.max(0, Number(value) || 0);
	}
	return fault;
}

function setFault(spec) {
	_fault = parseFault(spec);
	console.log("[HTTP] fault injection:", _fault);
	return { ..._fault };
}

function getFault() {
	return { ..._fault };
}

async function _applyFault(signal) {
	if (_fault.latency) await sleep(_fault.latency, signal);
	if (_fault.offline || (_fault.flaky && Math.random() < _fault.flaky)) {
		throw new TypeError("fetch failed (injected fault)");
	}
}

// ── helpers ───────────────────────────────────────────────────────────────────

function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener?.("abort", () => {
			clearTimeout(timer);
			reject(signal.reason);
		}, { once: true });
	});
}

// Exponential backoff with full jitter: attempt 0 → up to `base`, doubling,
// capped at `max`.
function backoff(attempt, { base = 500, max = 5000 } = {}) {
	const ceiling = Math.min(max, base * 2 ** attempt);
	return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

function isTimeoutError(error) {
	return error?.name === "TimeoutError" || error?.cause?.name === "TimeoutError";
}

// A failure before any response: DNS, refused, reset, aborted by our timeout.
function connectionFailure(error) {
	const kind = isTimeoutError(error) ? "timeout" : "network";
	return {
		success: false,
		kind,
		offline: true,
		retryable: true,
		message: kind === "timeout" ? TIMEOUT_MESSAGE : OFFLINE_MESSAGE,
	};
}

function kindOfStatus(status) {
	if (status >= 200 && status < 300) return "ok";
	if (status === 401) return "auth";
	if (status >= 500) return "server";
	return "http";
}

// Reads a response body as JSON without throwing. Gateways/proxies return HTML
// error pages (e.g. a 502 "<!DOCTYPE html>…") that would otherwise blow up
// JSON.parse — fall back to a clean failure object instead.
async function readJson(response) {
	const text = await response.text();
	try {
		return JSON.parse(text);
	} catch {
		console.error(`[HTTP] non-JSON response (HTTP ${response.status})`);
		return { success: false, message: `Server error (HTTP ${response.status}). Please try again.` };
	}
}

// The backend nests each route's payload under a named key inside `data`
// (e.g. { data: { jobs: [...] } }). Unwrap that named key so callers receive the
// bare value as `data`. Untouched when the response failed or the key isn't present.
function unwrap(payload, key) {
	if (payload && payload.success && payload.data && typeof payload.data === "object" && key in payload.data) {
		return { ...payload, data: payload.data[key] };
	}
	return payload;
}

// ── requests ──────────────────────────────────────────────────────────────────

// One attempt. Never throws.
async function _attempt(method, path, { body, headers, timeoutMs }) {
	const signal = AbortSignal.timeout(timeoutMs);
	let result;
	try {
		await _applyFault(signal);
		const response = await fetch(`${API_BASE_URL}${path}`, {
			method,
			headers: body !== undefined ? { "Content-Type": "application/json", ...headers } : headers,
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal,
		});
		// The timeout covers reading the body too: a stall mid-body is as dead as
		// one before the headers.
		const payload = await readJson(response);
		const kind = kindOfStatus(response.status);
		result = {
			...payload,
			success: kind === "ok" ? payload?.success !== false : false,
			status: response.status,
			kind,
			offline: false,
			retryable: kind === "server",
		};
		if (kind === "auth" && !payload?.message) result.message = "Your session has expired. Please log in again.";
	} catch (error) {
		result = connectionFailure(error);
		console.warn(`[HTTP] ${method} ${path} → ${result.kind}: ${error.message}`);
	}
	_report({ kind: result.kind, status: result.status, method, path });
	return result;
}

// request(method, path, opts) → result (see the header). Never throws.
//   body       JSON-serialised when given
//   headers    extra headers (e.g. Authorization)
//   timeoutMs  per attempt; defaults by method
//   retries    extra attempts for retryable failures — only pass this for calls
//              that are safe to repeat (GETs, idempotent PATCHes)
async function request(method, path, { body, headers = {}, timeoutMs, retries = 0 } = {}) {
	const timeout = timeoutMs ?? (method === "GET" ? DEFAULT_GET_TIMEOUT_MS : DEFAULT_WRITE_TIMEOUT_MS);
	let result = await _attempt(method, path, { body, headers, timeoutMs: timeout });
	for (let attempt = 0; attempt < retries && result.retryable; attempt++) {
		await sleep(backoff(attempt));
		result = await _attempt(method, path, { body, headers, timeoutMs: timeout });
	}
	return result;
}

// For streaming downloads: resolves { ok: true, response } once headers arrive
// (within `connectTimeoutMs`), or a failure result. The caller reads the body
// itself — with its own stall detection — and passes `controller` to abort it.
async function requestStream(path, { headers = {}, connectTimeoutMs = DEFAULT_GET_TIMEOUT_MS, controller = new AbortController() } = {}) {
	const timer = setTimeout(() => controller.abort(new DOMException("connect timed out", "TimeoutError")), connectTimeoutMs);
	try {
		await _applyFault(controller.signal);
		const response = await fetch(`${API_BASE_URL}${path}`, { headers, signal: controller.signal });
		clearTimeout(timer);
		const kind = kindOfStatus(response.status);
		_report({ kind, status: response.status, method: "GET", path });
		if (kind !== "ok") {
			// Drain so the socket can be reused; the body is only an error page.
			response.body?.cancel?.().catch(() => {});
			return { ok: false, status: response.status, kind, offline: false, retryable: kind === "server" };
		}
		return { ok: true, status: response.status, response, controller };
	} catch (error) {
		clearTimeout(timer);
		const failure = connectionFailure(controller.signal.reason?.name === "TimeoutError" ? controller.signal.reason : error);
		console.warn(`[HTTP] GET ${path} (stream) → ${failure.kind}: ${error.message}`);
		_report({ kind: failure.kind, method: "GET", path });
		return { ok: false, ...failure };
	}
}

// Shapes a thrown error the way request() reports connection failures.
function apiError(error) {
	return {
		success: false,
		kind: "network",
		offline: true,
		retryable: true,
		message: error?.message === "fetch failed" ? OFFLINE_MESSAGE : "An unexpected error occurred. Please try again.",
	};
}

module.exports = {
	baseUrl,
	setBaseUrl,
	request,
	requestStream,
	readJson,
	unwrap,
	apiError,
	onOutcome,
	setFault,
	getFault,
	parseFault,
	backoff,
	sleep,
	OFFLINE_MESSAGE,
};
