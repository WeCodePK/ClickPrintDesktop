// The HTTP layer every backend call goes through (main/http.js): each request
// is bounded by a timeout, every failure is sorted into a kind, retries only
// repeat what's worth repeating, and every outcome is reported for the
// connectivity tracker. Runs against a local server.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const nodeHttp = require("node:http");

const http = require("../main/http");

let server;
let port;
let handler = (req, res) => res.end("{}");
const outcomes = [];

before(async () => {
	server = nodeHttp.createServer((req, res) => handler(req, res));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = server.address().port;
	http.setBaseUrl(`http://127.0.0.1:${port}`);
	http.onOutcome((o) => outcomes.push(o.kind));
});

after(() => server.close());

beforeEach(() => {
	outcomes.length = 0;
	http.setFault("");
});

const json = (status, body) => (req, res) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));

test("a successful call keeps the backend's shape and adds its status", async () => {
	handler = json(200, { success: true, data: { jobs: [1, 2] } });
	const result = http.unwrap(await http.request("GET", "/x"), "jobs");
	assert.equal(result.success, true);
	assert.deepEqual(result.data, [1, 2]);
	assert.equal(result.status, 200);
	assert.equal(result.kind, "ok");
	assert.deepEqual(outcomes, ["ok"]);
});

test("a JSON body is sent with its content type", async () => {
	let seen;
	handler = (req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			seen = { type: req.headers["content-type"], body: JSON.parse(body), auth: req.headers.authorization };
			json(200, { success: true })(req, res);
		});
	};
	await http.request("PATCH", "/x", { body: { status: "queued" }, headers: { Authorization: "Bearer t" } });
	assert.deepEqual(seen, { type: "application/json", body: { status: "queued" }, auth: "Bearer t" });
});

test("401 is an auth failure, not an outage", async () => {
	handler = json(401, { success: false, message: "jwt expired" });
	const result = await http.request("GET", "/x");
	assert.equal(result.kind, "auth");
	assert.equal(result.offline, false);
	assert.equal(result.success, false);
});

test("a gateway's HTML error page is a retryable server failure", async () => {
	handler = (req, res) => res.writeHead(502).end("<!DOCTYPE html><h1>Bad gateway</h1>");
	const result = await http.request("GET", "/x");
	assert.equal(result.kind, "server");
	assert.equal(result.retryable, true);
	assert.match(result.message, /HTTP 502/);
});

test("a rejection (4xx) is final: not offline, not retryable", async () => {
	handler = json(409, { success: false, message: "invalid transition" });
	const result = await http.request("PATCH", "/x", { body: {}, retries: 3 });
	assert.equal(result.kind, "http");
	assert.equal(result.retryable, false);
	assert.equal(result.message, "invalid transition");
	assert.deepEqual(outcomes, ["http"], "never retried");
});

test("a server that never answers times out instead of hanging", async () => {
	handler = () => {}; // never responds
	const started = Date.now();
	const result = await http.request("GET", "/x", { timeoutMs: 200 });
	assert.ok(Date.now() - started < 2000);
	assert.equal(result.kind, "timeout");
	assert.equal(result.offline, true);
	assert.deepEqual(outcomes, ["timeout"]);
});

test("an unreachable server is a network failure", async () => {
	http.setBaseUrl("http://127.0.0.1:1");
	const result = await http.request("GET", "/x");
	http.setBaseUrl(`http://127.0.0.1:${port}`);
	assert.equal(result.kind, "network");
	assert.equal(result.offline, true);
	assert.equal(result.success, false);
});

test("retries repeat retryable failures until one succeeds", async () => {
	let calls = 0;
	handler = (req, res) => (++calls < 3 ? json(503, { success: false })(req, res) : json(200, { success: true, data: 1 })(req, res));
	const result = await http.request("GET", "/x", { retries: 3 });
	assert.equal(result.success, true);
	assert.equal(calls, 3);
});

test("fault injection fails requests without reaching the server", async () => {
	let reached = false;
	handler = (req, res) => {
		reached = true;
		json(200, { success: true })(req, res);
	};
	http.setFault("offline");
	const result = await http.request("GET", "/x");
	assert.equal(result.kind, "network");
	assert.equal(reached, false);
	assert.deepEqual(http.parseFault("flaky:0.4,latency:300"), { offline: false, flaky: 0.4, latency: 300 });
});

test("a stream opens once headers arrive, and a refusal never streams", async () => {
	handler = (req, res) => (req.url === "/ok" ? res.writeHead(200).end("bytes") : res.writeHead(404).end("nope"));
	const ok = await http.requestStream("/ok");
	assert.equal(ok.ok, true);
	assert.equal(await ok.response.text(), "bytes");
	const missing = await http.requestStream("/missing");
	assert.deepEqual([missing.ok, missing.kind, missing.status], [false, "http", 404]);
});
