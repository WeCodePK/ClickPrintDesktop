const STORE_KEY = "whatsappJobReadyNotifications";
const SENT_LIMIT = 1000;

function readyNotification(job) {
	if (job?.status !== "completed" || job.source !== "shop" || job.channel !== "whatsapp") return null;
	const shopId = typeof job.shop === "string" ? job.shop : job.shop?._id;
	const to = typeof job.customer?.number === "string" ? job.customer.number.trim() : "";
	if (typeof job._id !== "string" || !job._id || typeof shopId !== "string" || !shopId || !/^923\d{9}$/.test(to)) {
		console.error(`[WA] cannot notify completed job ${job._id}: missing shop or customer number`);
		return null;
	}

	const code = job.code ? ` (job *#${job.code}*)` : "";
	let text = `Your print${code} is ready! Head to the shop to collect it.`;
	// Online orders attach a payment proof; the current job schema has no
	// separate payment-method field. WhatsApp orders without a proof use COP.
	if (!job.paymentProofFile && !job.paymentProofFileId) {
		const total = job.cost?.total;
		if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
			console.error(`[WA] cannot notify completed COP job ${job._id}: invalid total`);
			return null;
		}
		text += `\nPlease bring *Rs. ${total.toLocaleString("en-PK", { maximumFractionDigits: 2 })}* for Cash on Pickup.`;
	}
	return { id: `job-ready:${shopId}:${job._id}`, shopId, to, text };
}

// Keep only outgoing messages and recent sent ids, rather than copies of jobs.
// Pending messages survive restarts and are sent only through their shop's link.
function createJobNotifications(store) {
	const flushing = new Map();
	// If sending succeeds but saving the acknowledgement fails, retry the save
	// without sending again during this app session.
	const delivered = new Set();

	function read() {
		const saved = store.get(STORE_KEY);
		return {
			pending: saved?.pending && typeof saved.pending === "object" && !Array.isArray(saved.pending) ? saved.pending : {},
			sent: saved?.sent && typeof saved.sent === "object" && !Array.isArray(saved.sent) ? saved.sent : {},
		};
	}

	function sentIds(state, shopId) {
		return Array.isArray(state.sent[shopId]) ? state.sent[shopId] : [];
	}

	function enqueue(job) {
		const notification = readyNotification(job);
		if (!notification) return false;
		const state = read();
		if (sentIds(state, notification.shopId).includes(notification.id)) return false;
		if (state.pending[notification.id]) return true;
		state.pending[notification.id] = notification;
		if (!store.set(STORE_KEY, state)) {
			console.error(`[WA] could not save ready notification ${notification.id}`);
			return false;
		}
		return true;
	}

	async function drain(shopId, send) {
		while (true) {
			const state = read();
			const notification = Object.values(state.pending).find((entry) => entry?.shopId === shopId);
			if (!notification) return;
			if (!delivered.has(notification.id) && !sentIds(state, shopId).includes(notification.id)) {
				if (!await send(notification)) return;
				delivered.add(notification.id);
			}
			// Other completed jobs may have been queued while the send was awaiting.
			const latest = read();
			delete latest.pending[notification.id];
			latest.sent[shopId] = [...sentIds(latest, shopId).filter((id) => id !== notification.id), notification.id].slice(-SENT_LIMIT);
			if (!store.set(STORE_KEY, latest)) {
				console.error(`[WA] could not acknowledge ready notification ${notification.id}`);
				return;
			}
			delivered.delete(notification.id);
		}
	}

	function flush(shopId, send) {
		if (flushing.has(shopId)) return flushing.get(shopId);
		const task = drain(shopId, send)
			.catch((error) => console.error("[WA] ready notification queue failed:", error.message))
			.finally(() => flushing.delete(shopId));
		flushing.set(shopId, task);
		return task;
	}

	return { enqueue, flush };
}

module.exports = { createJobNotifications };
