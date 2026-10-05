// WhatsApp texts that wait for the linked socket (main/whatsappOutbox.js): kept
// across restarts, sent in order once WhatsApp is back, never sent twice, and
// replies that waited too long are dropped rather than confusing the customer.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createWhatsAppOutbox, REPLY_EXPIRES_MS } = require("../main/whatsappOutbox");

function memoryStore(data = new Map()) {
	return {
		data,
		get: (key) => (data.has(key) ? JSON.parse(data.get(key)) : undefined),
		set: (key, value) => (data.set(key, JSON.stringify(value)), true),
	};
}

test("queued texts go out in order once WhatsApp is back", async () => {
	const outbox = createWhatsAppOutbox(memoryStore());
	outbox.enqueue({ id: "a", shopId: "s1", jid: "92300@s.whatsapp.net", text: "one" });
	outbox.enqueueReply("s1", "92300@s.whatsapp.net", "two");
	const sent = [];
	await outbox.flush("s1", async ({ text }) => (sent.push(text), true));
	assert.deepEqual(sent, ["one", "two"]);
	assert.equal(outbox.pendingCount("s1"), 0);
});

test("a failed send stops the flush and keeps the rest, in order", async () => {
	const outbox = createWhatsAppOutbox(memoryStore());
	for (const text of ["one", "two", "three"]) outbox.enqueueReply("s1", "j", text);
	let calls = 0;
	await outbox.flush("s1", async () => ++calls < 2);
	assert.equal(outbox.pendingCount("s1"), 2);
	const sent = [];
	await outbox.flush("s1", async ({ text }) => (sent.push(text), true));
	assert.deepEqual(sent, ["two", "three"]);
});

test("the queue survives a restart, and a sent id is never sent again", async () => {
	const store = memoryStore();
	createWhatsAppOutbox(store).enqueue({ id: "sse-1", shopId: "s1", jid: "j", text: "hi" });
	const reopened = createWhatsAppOutbox(store);
	assert.equal(reopened.pendingCount("s1"), 1);
	await reopened.flush("s1", async () => true);
	assert.equal(reopened.wasSent("sse-1"), true);
	assert.equal(reopened.enqueue({ id: "sse-1", shopId: "s1", jid: "j", text: "hi" }), false);
});

test("a reply that waited too long is dropped instead of sent", async () => {
	let clock = 1000;
	const outbox = createWhatsAppOutbox(memoryStore(), { now: () => clock });
	outbox.enqueueReply("s1", "j", "menu");
	outbox.enqueue({ id: "sse-2", shopId: "s1", jid: "j", text: "from the backend" });
	clock += REPLY_EXPIRES_MS + 1;
	const sent = [];
	await outbox.flush("s1", async ({ text }) => (sent.push(text), true));
	assert.deepEqual(sent, ["from the backend"], "backend sends don't expire");
});

test("each shop's queue is its own", async () => {
	const outbox = createWhatsAppOutbox(memoryStore());
	outbox.enqueueReply("s1", "j", "for s1");
	outbox.enqueueReply("s2", "j", "for s2");
	const sent = [];
	await outbox.flush("s2", async ({ text }) => (sent.push(text), true));
	assert.deepEqual(sent, ["for s2"]);
	assert.equal(outbox.pendingCount("s1"), 1);
});
