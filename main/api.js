const EventSource = require("eventsource");
// const { getAuth, setAuth, setJobs } = require("./app-state");

const API_BASE_URL = "https://clickprintbackend.wckd.pk"

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
				phoneNumber: number,
			});
			console.log("[API] Auth token stored");
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
	fetchJobs,
	startJobsSse,
	stopJobsSse,
};
