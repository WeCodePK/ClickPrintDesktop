// WhatsApp texts that couldn't go out because the shop's linked socket wasn't
// connected (the link dropped, WhatsApp is reconnecting) — kept on disk and
// sent, in order, once it's back. Two kinds of message land here:
//   - replies to a customer, which expire (EXPIRES_MS): a menu or a "files
//     received" that arrives hours late is worse than none;
//   - texts the backend asked for over SSE ("whatsappSend"), which don't.
// Ids already sent are remembered, so an SSE replay can't send one twice.
//
// No Electron imports — tested under plain `node --test`.

const STORE_KEY = "whatsappOutbox";
const SENT_LIMIT = 500;
const REPLY_EXPIRES_MS = 2 * 60 * 60 * 1000;

function createWhatsAppOutbox(store, { now = () => Date.now() } = {}) {
	const flushing = new Map();

	function read() {
		const saved = store.get(STORE_KEY);
		return {
			pending: Array.isArray(saved?.pending) ? saved.pending : [],
			sent: Array.isArray(saved?.sent) ? saved.sent : [],
		};
	}

	// Queues { id, shopId, jid, text, expiresAt? }. False when it's a duplicate.
	function enqueue(message) {
		if (!message?.id || !message.shopId || !message.jid || !message.text) return false;
		const state = read();
		if (state.sent.includes(message.id) || state.pending.some((m) => m.id === message.id)) return false;
		state.pending.push({ ...message, queuedAt: now() });
		store.set(STORE_KEY, state);
		console.log(`[WA] queued ${message.id} for ${message.jid} until WhatsApp reconnects`);
		return true;
	}

	// A reply to a customer: expires, since late conversation is confusing.
	function enqueueReply(shopId, jid, text) {
		return enqueue({ id: `reply:${now()}:${Math.random().toString(36).slice(2, 8)}`, shopId, jid, text, expiresAt: now() + REPLY_EXPIRES_MS });
	}

	function pendingCount(shopId) {
		return read().pending.filter((m) => m.shopId === shopId).length;
	}

	// send({ jid, text }) → Promise<boolean>. Stops at the first failure, so
	// order per shop is kept.
	async function drain(shopId, send) {
		while (true) {
			const state = read();
			const next = state.pending.find((m) => m.shopId === shopId);
			if (!next) return;
			const expired = next.expiresAt && next.expiresAt < now();
			if (expired) {
				console.log(`[WA] dropping ${next.id} to ${next.jid}: it waited too long to be useful`);
			} else if (!(await send(next))) {
				return;
			}
			const latest = read();
			latest.pending = latest.pending.filter((m) => m.id !== next.id);
			if (!expired) latest.sent = [...latest.sent.filter((id) => id !== next.id), next.id].slice(-SENT_LIMIT);
			store.set(STORE_KEY, latest);
		}
	}

	function flush(shopId, send) {
		if (flushing.has(shopId)) return flushing.get(shopId);
		const task = drain(shopId, send)
			.catch((error) => console.error("[WA] outbox flush failed:", error.message))
			.finally(() => flushing.delete(shopId));
		flushing.set(shopId, task);
		return task;
	}

	// Marks an id as already delivered (sent directly) so a later replay of the
	// same request is skipped.
	function markSent(id) {
		if (!id) return;
		const state = read();
		if (state.sent.includes(id)) return;
		state.sent = [...state.sent, id].slice(-SENT_LIMIT);
		store.set(STORE_KEY, state);
	}

	function wasSent(id) {
		return !!id && read().sent.includes(id);
	}

	return { enqueue, enqueueReply, flush, pendingCount, markSent, wasSent };
}

module.exports = { createWhatsAppOutbox, REPLY_EXPIRES_MS };
