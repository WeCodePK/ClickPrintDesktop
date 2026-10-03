const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createExcludedContacts, normalizeContactId } = require("../main/whatsappContacts");

function diskStore(folder) {
	const module = { exports: {} };
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../main/store.js"), "utf8"), {
		module, console, JSON,
		require: (id) => id === "electron" ? { app: { getPath: () => folder } } : require(id),
	});
	return module.exports;
}

function temporaryFolder(t) {
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), "clickprint-wa-exclusions-"));
	t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
	return folder;
}

function message(jid, content = { conversation: "confirm" }, alt) {
	return { key: { remoteJid: jid, remoteJidAlt: alt, id: "message", fromMe: false }, message: content, pushName: "Customer" };
}

test("excluded contacts survive store reloads and remain scoped to each shop", (t) => {
	const folder = temporaryFolder(t);
	const first = createExcludedContacts(diskStore(folder));
	assert.equal(first.add("shop1", { id: "+92 300-1234567", name: " Ali " }).success, true);
	assert.equal(first.add("shop2", { id: "1234567890@lid" }).success, true);
	assert.equal(first.add("shop1", { id: "03001234567" }).success, false);

	const restarted = createExcludedContacts(diskStore(folder));
	assert.deepEqual(restarted.list("shop1"), [{ id: "+923001234567", name: "Ali" }]);
	assert.deepEqual(restarted.list("shop2"), [{ id: "1234567890@lid", name: null }]);
	assert.equal(restarted.remove("shop1", "923001234567:12@s.whatsapp.net").success, true);
	const again = createExcludedContacts(diskStore(folder));
	assert.deepEqual(again.list("shop1"), []);
	assert.equal(again.list("shop2").length, 1);
});

test("exclusions match phone and LID aliases without treating LID digits as phone numbers", async (t) => {
	const contacts = createExcludedContacts(diskStore(temporaryFolder(t)));
	contacts.add("phone-shop", { id: "+923001234567" });
	contacts.add("lid-shop", { id: "1234567890@lid" });
	const sock = { signalRepository: { lidMapping: {
		getPNForLID: async (jid) => jid.startsWith("1234567890") ? "923001234567@s.whatsapp.net" : null,
		getLIDForPN: async (jid) => jid.startsWith("923001234567") ? "1234567890:2@lid" : null,
	} } };
	assert.equal(await contacts.isExcluded("phone-shop", message("923001234567:5@s.whatsapp.net"), sock), true);
	assert.equal(await contacts.isExcluded("phone-shop", message("1234567890@lid"), sock), true);
	assert.equal(await contacts.isExcluded("phone-shop", message("9999999999@lid", undefined, "923001234567@s.whatsapp.net"), {}), true);
	assert.equal(await contacts.isExcluded("lid-shop", message("923001234567@s.whatsapp.net"), sock), true);
	assert.equal(await contacts.isExcluded("lid-shop", message("1234567890:3@lid"), {}), true);
	assert.equal(await contacts.isExcluded("phone-shop", message("923001234567@lid"), {}), false);
	assert.equal(await contacts.isExcluded("phone-shop", message("923009999999@s.whatsapp.net"), sock), false);
	assert.equal(await contacts.isExcluded("other-shop", message("1234567890@lid"), sock), false);
	assert.equal(normalizeContactId("0092 300 1234567"), "+923001234567");
	assert.equal(normalizeContactId("1234567890@g.us"), null);
});

test("a failed disk write is reported without claiming the contact was saved", () => {
	const contacts = createExcludedContacts({ get: () => ({}), set: () => false });
	assert.equal(contacts.add("shop1", { id: "+923001234567" }).success, false);
	assert.deepEqual(contacts.list("shop1"), []);
});

// Exercise the real incoming queue/handlers with a fake socket and ordering
// flows. Private bindings are exposed only in this VM, not in production.
function whatsappHarness(folder, flowOverride = {}) {
	const effects = [];
	const store = diskStore(folder);
	const flow = {
		handleText: async (_shop, _customer, text) => { effects.push(["text", text]); return null; },
		addFile: async () => { effects.push(["addFile"]); return null; },
		...flowOverride,
	};
	const module = { exports: {} };
	const source = fs.readFileSync(path.join(__dirname, "../main/whatsapp.js"), "utf8");
	vm.runInNewContext(source + `
		_baileys = Promise.resolve({
			isPnUser: (jid) => typeof jid === 'string' && jid.endsWith('@s.whatsapp.net'),
			isLidUser: (jid) => typeof jid === 'string' && jid.endsWith('@lid')
		});
		module.exports.testIncoming = _onMessagesUpsert;
		module.exports.testSocket = (sock) => { _sock = sock; _snapshot.state = 'open'; };
		module.exports.testIdle = () => Promise.all([..._chatQueues.values()]);
		module.exports.testPending = () => _pendingMedia.size;
		_handleMedia = async () => { effects.push(['download']); return { file: { _id: 'f1', numberOfPages: 1 }, name: 'a.pdf' }; };
	`, {
		module, console, setTimeout, clearTimeout, effects,
		require: (id) => {
			if (id === "electron") return { app: { getPath: () => folder } };
			if (id === "pino") return () => ({});
			if (id === "qrcode") return {};
			if (id === "./api") return { uploadFile: async () => { effects.push(["upload"]); } };
			if (id === "./store") return store;
			if (id === "./whatsappMenuFlow") return { createMenuFlow: () => flow };
			if (id === "./whatsappChatFlow") return { createChatFlow: () => flow };
			return id.startsWith("./") ? require(path.join(__dirname, "../main", id)) : require(id);
		},
	});
	const whatsapp = module.exports;
	const sock = {
		sendReceipt: async () => {},
		readMessages: async () => { effects.push(["read"]); },
		sendMessage: async () => { effects.push(["send"]); },
		end: () => {},
	};
	whatsapp.start("shop1");
	whatsapp.testSocket(sock);
	const incoming = async (messages) => {
		await whatsapp.testIncoming(sock, "shop1", { type: "notify", messages });
		await whatsapp.testIdle();
	};
	return { whatsapp, sock, effects, incoming };
}

test("excluded text and documents never reach downloads, drafts, inference, reads or replies", async (t) => {
	const folder = temporaryFolder(t);
	const h = whatsappHarness(folder);
	assert.equal(h.whatsapp.addExcludedContact({ id: "+923001234567" }).success, true);
	const media = { documentMessage: { fileName: "a.pdf", mimetype: "application/pdf" } };
	await h.incoming([
		message("923001234567@s.whatsapp.net"),
		message("1234567890@lid", media, "923001234567@s.whatsapp.net"),
	]);
	assert.deepEqual(h.effects, []);
	assert.equal(h.whatsapp.testPending(), 0);

	const restarted = whatsappHarness(folder);
	assert.equal(restarted.whatsapp.getSnapshot().excludedContacts.length, 1);
	await restarted.incoming([message("923001234567@s.whatsapp.net")]);
	assert.deepEqual(restarted.effects, []);
	assert.equal(restarted.whatsapp.removeExcludedContact("+923001234567").success, true);
	await restarted.incoming([message("923001234567@s.whatsapp.net", { conversation: "hello" })]);
	assert.deepEqual(restarted.effects, [["text", "hello"]]);
});

test("adding an exclusion stops text and media already waiting in the incoming queue", async (t) => {
	let release;
	let started;
	const waiting = new Promise((resolve) => { release = resolve; });
	const firstStarted = new Promise((resolve) => { started = resolve; });
	const handled = [];
	const h = whatsappHarness(temporaryFolder(t), {
		handleText: async (_shop, _customer, text) => {
			handled.push(text);
			started();
			await waiting;
			return null;
		},
	});
	const jid = "923001234567@s.whatsapp.net";
	await h.whatsapp.testIncoming(h.sock, "shop1", { type: "notify", messages: [
		message(jid, { conversation: "first" }),
		message(jid, { conversation: "confirm" }),
		message(jid, { documentMessage: { fileName: "a.pdf", mimetype: "application/pdf" } }),
	] });
	await firstStarted;
	h.whatsapp.addExcludedContact({ id: "+923001234567" });
	release();
	await h.whatsapp.testIdle();
	assert.deepEqual(handled, ["first"]);
	assert.deepEqual(h.effects, []);
	assert.equal(h.whatsapp.testPending(), 0);
});
