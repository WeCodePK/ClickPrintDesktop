const spooler = require("./spooler");

// ─────────────────────────────────────────────────────────────────────────────
// The printer registry: the single source of truth for "which printers can serve
// which service, and what is each of those printers currently working on".
//
// Shape (see getSnapshot):
//   [ { serviceId, name, keys, isDisabled,
//       printers: { "HP LaserJet": { load, queue: [...], foreign, online, … } } } ]
//
// Every printer key holds a queue AT ALL TIMES (an empty array when idle) — the
// queue is created the moment a printer is seen, never lazily on first print.
//
// Two kinds of load live in a printer's queue:
//   • docs    — documents WE spooled, tracked by their Windows spool job id.
//   • foreign — anything else already in that printer's physical queue (another
//               app, another workstation). Counted so load balancing reflects
//               reality rather than only our own traffic.
//
// The queues are reconciled against the real Windows spooler (reconcile(), run
// on every SSE ping and on startup): a doc whose spool job has left the physical
// queue — printed, failed, or cancelled by the operator in the Windows UI — is
// dropped. That is what keeps this object honest without the engine having to
// remember to clean up after every terminal outcome.
// ─────────────────────────────────────────────────────────────────────────────

function isPdfDevice(name) {
	return /print to pdf/i.test(name || "");
}

// device -> { docs: [{taskId, jobId, fileId, fileName, spoolId, state, at}], foreign }
const _queues = new Map();

// Resolved services: [{ serviceId, name, keys, isDisabled, devices: [{name, useAuto, isDisabled, printerId}] }]
let _services = [];

// Device names reachable on this machine right now (from printers.listPrinters).
let _online = new Set();

let _onChange = null;

function setChangeNotifier(fn) {
	_onChange = fn;
}

function _changed() {
	if (_onChange) _onChange();
}

// Every printer we've ever seen keeps a queue for the life of the process, so
// callers can always read a depth without null-checking.
function _queue(device) {
	let q = _queues.get(device);
	if (!q) {
		q = { docs: [], foreign: 0 };
		_queues.set(device, q);
	}
	return q;
}

// ── routing table ────────────────────────────────────────────────────────────

// A document routes to a printer through its service: match the file's settings
// to a service's keys. File settings use sidedness "none"|"long"|"short";
// service keys use a boolean (double-sided or not).
function matchesService(settings = {}, keys = {}) {
	return (
		keys.pageType === settings.pageType &&
		!!keys.color === !!settings.color &&
		!!keys.sidedness === (!!settings.sidedness && settings.sidedness !== "none")
	);
}

function findService(settings) {
	return _services.find((s) => !s.isDisabled && matchesService(settings, s.keys)) || null;
}

// Rebuilds the service → printer structure from the backend's services and
// registered printers plus the live local printer list. Queues survive a rebuild
// (they're keyed by device, not by service), so in-flight work is never lost
// when a service is edited or a printer briefly drops offline.
function rebuild({ services = [], registeredPrinters = [], localPrinters = [] } = {}) {
	_online = new Set((localPrinters || []).map((p) => p.name));

	const resolveRegistered = (entry) => {
		const id = typeof entry.printer === "string" ? entry.printer : entry.printer?._id;
		return (
			(registeredPrinters || []).find((p) => p._id === id) ||
			(typeof entry.printer === "object" ? entry.printer : null)
		);
	};

	_services = (services || []).map((service) => {
		const devices = [];
		for (const entry of service.printers || []) {
			const reg = resolveRegistered(entry);
			if (!reg || !reg.name) continue;
			devices.push({
				name: reg.name,
				printerId: reg._id,
				useAuto: !!entry.useAuto,
				isDisabled: !!reg.isDisabled,
			});
			_queue(reg.name); // a selected printer always has a queue
		}
		return {
			serviceId: service._id,
			name: service.name,
			keys: service.keys || {},
			isDisabled: !!service.isDisabled,
			devices,
		};
	});

	// Manual overrides can target any online printer, so those get queues too.
	for (const name of _online) _queue(name);

	_changed();
}

// ── queue bookkeeping ────────────────────────────────────────────────────────

// Records a document as occupying a printer's queue. Called the instant a task
// is dispatched — BEFORE spooling — so concurrent load-balancing decisions in
// the same scheduling pass already see this printer as busier.
function enqueue(device, { taskId, jobId, fileId, fileName }) {
	const q = _queue(device);
	const existing = q.docs.find((d) => d.taskId === taskId);
	if (existing) return existing;
	const doc = { taskId, jobId, fileId, fileName, spoolId: null, state: "spooling", at: Date.now() };
	q.docs.push(doc);
	_changed();
	return doc;
}

// Attaches the Windows spool job id once the spooler has identified it. Until
// this lands the doc is immune to reconcile() (it isn't in the physical queue
// yet), which is what stops a just-dispatched doc from being swept away.
function setSpoolId(device, taskId, spoolId) {
	const doc = _queue(device).docs.find((d) => d.taskId === taskId);
	if (!doc) return;
	doc.spoolId = typeof spoolId === "number" ? spoolId : null;
	doc.spoolIdAt = Date.now();
	doc.state = "printing";
	_changed();
}

// Removes a document from a printer's queue (terminal outcome, or the job was
// cancelled/dropped). Idempotent — reconcile() may have removed it already.
function dequeue(device, taskId) {
	const q = _queues.get(device);
	if (!q) return;
	const next = q.docs.filter((d) => d.taskId !== taskId);
	if (next.length === q.docs.length) return;
	q.docs = next;
	_changed();
}

// Drops every queued doc belonging to a job, across all printers (job cancelled,
// completed, or failed).
function dropJob(jobId) {
	let mutated = false;
	for (const q of _queues.values()) {
		const next = q.docs.filter((d) => d.jobId !== jobId);
		if (next.length !== q.docs.length) {
			q.docs = next;
			mutated = true;
		}
	}
	if (mutated) _changed();
}

// Total pressure on a printer: our tracked docs plus whatever else is already
// sitting in its physical queue.
function loadOf(device) {
	const q = _queues.get(device);
	return q ? q.docs.length + q.foreign : 0;
}

// ── reconciliation with the real Windows spooler ─────────────────────────────

// Sweeps every known printer's physical queue and drops our docs that are no
// longer in it (completed or failed), refreshing the foreign-job counts at the
// same time. Safe to call repeatedly and concurrently — a failed query leaves
// the current state untouched rather than clearing it.
let _reconciling = false;

async function reconcile() {
	if (_reconciling) return;
	const devices = [..._queues.keys()].filter((d) => !isPdfDevice(d));
	if (devices.length === 0) return;

	_reconciling = true;
	try {
		// Everything read back from this query describes the queues as they were
		// at this instant. A document that gets its spool id *after* this point
		// cannot be judged against it — see the spoolIdAt guard below.
		const queriedAt = Date.now();
		const queues = await spooler.queryQueues(devices);
		if (!queues) return; // spooler unqueryable — keep what we have

		let mutated = false;
		for (const device of devices) {
			const rows = queues[device] || [];
			const liveIds = new Set(rows.map((r) => r && r.Id).filter((id) => typeof id === "number"));
			const q = _queue(device);

			// A doc is swept only when this reading is actually able to speak about
			// it. Never swept:
			//   • no spool id yet — it isn't in the physical queue, and dropping it
			//     would let the load balancer double-book the printer;
			//   • spool id assigned after the query was issued — the snapshot predates
			//     the job, so its absence proves nothing (PowerShell can take seconds).
			const before = q.docs.length;
			q.docs = q.docs.filter(
				(d) => d.spoolId == null || d.spoolIdAt > queriedAt || liveIds.has(d.spoolId)
			);

			// Anything in the physical queue we can't attribute to a tracked doc is
			// foreign load. Documents of ours still awaiting a spool id are already
			// counted in q.docs, so discount them here — otherwise a single in-flight
			// document briefly reads as two and skews the load balancer.
			const ours = new Set(q.docs.map((d) => d.spoolId).filter((id) => id != null));
			const pending = q.docs.filter((d) => d.spoolId == null).length;
			const unattributed = [...liveIds].filter((id) => !ours.has(id)).length;
			const foreign = Math.max(0, unattributed - pending);

			if (before !== q.docs.length || q.foreign !== foreign) mutated = true;
			q.foreign = foreign;
		}
		if (mutated) _changed();
	} finally {
		_reconciling = false;
	}
}

// ── load balancing ───────────────────────────────────────────────────────────

// Least-loaded pick with an early exit: walk the candidates in order and take
// the first completely idle printer; otherwise remember the lightest and return
// that once the list is exhausted.
function leastLoaded(devices) {
	let best = null;
	let bestLoad = Infinity;
	for (const device of devices) {
		const load = loadOf(device);
		if (load === 0) return device; // idle printer — stop looking
		if (load < bestLoad) {
			bestLoad = load;
			best = device;
		}
	}
	return best;
}

// Picks the printer a document should go to.
//   • overrideDevice — the operator chose one explicitly from the dropdown;
//     honour it as long as it's reachable (PDF pseudo-printers always are).
//   • otherwise      — match the document to its service and load-balance across
//     that service's eligible printers.
//   • exclude        — devices already tried for this document (a retry prefers
//     a different printer, but will reuse one if it's the only option).
// Returns { device, reason }: reason is a wait code when no printer is usable.
function choosePrinter(settings, { mode = "manual", overrideDevice = null, exclude = [] } = {}) {
	if (overrideDevice) {
		if (isPdfDevice(overrideDevice) || _online.has(overrideDevice)) {
			return { device: overrideDevice, reason: null };
		}
		return { device: null, reason: "no-online-printer" };
	}

	const service = findService(settings);
	if (!service) return { device: null, reason: "route" };

	const configured = service.devices.filter((d) => {
		if (d.isDisabled) return false;
		// Print-to-PDF is eligible for automated printing like any other printer the
		// operator marked useAuto. Note it prints by asking for a save location
		// (files.savePdfCopy), so an unattended queue will wait on that dialog.
		if (mode === "auto" && !d.useAuto) return false;
		return true;
	});
	if (configured.length === 0) return { device: null, reason: "route" };

	const reachable = configured.filter((d) => _online.has(d.name) || isPdfDevice(d.name)).map((d) => d.name);
	if (reachable.length === 0) return { device: null, reason: "no-online-printer" };

	const skip = new Set(exclude);
	const untried = reachable.filter((name) => !skip.has(name));

	return { device: leastLoaded(untried.length ? untried : reachable), reason: null };
}

// ── snapshots ────────────────────────────────────────────────────────────────

// The literal services → printers → queue view, for the renderer and for debugging.
function getSnapshot() {
	return _services.map((service) => {
		const printers = {};
		for (const device of service.devices) {
			const q = _queue(device.name);
			printers[device.name] = {
				online: _online.has(device.name),
				useAuto: device.useAuto,
				isDisabled: device.isDisabled,
				load: loadOf(device.name),
				foreign: q.foreign,
				queue: q.docs.map((d) => ({
					jobId: d.jobId,
					fileId: d.fileId,
					fileName: d.fileName,
					spoolId: d.spoolId,
					state: d.state,
				})),
			};
		}
		return {
			serviceId: service.serviceId,
			name: service.name,
			keys: service.keys,
			isDisabled: service.isDisabled,
			printers,
		};
	});
}

// Flat device → queue view used by the engine's own state snapshot.
function getDeviceLoads() {
	const out = {};
	for (const [device, q] of _queues) {
		out[device] = {
			load: q.docs.length + q.foreign,
			foreign: q.foreign,
			online: _online.has(device),
			queue: q.docs.map((d) => ({ jobId: d.jobId, fileId: d.fileId, state: d.state, spoolId: d.spoolId })),
		};
	}
	return out;
}

// True when at least one enabled service has an automated, enabled printer
// registered — Print-to-PDF included. Gates the auto-print toggle; deliberately
// ignores online-ness so a briefly powered-off printer doesn't disable the
// feature.
function hasAutoRoute() {
	return _services.some((s) => !s.isDisabled && s.devices.some((d) => d.useAuto && !d.isDisabled));
}

function reset() {
	_queues.clear();
	_services = [];
	_online = new Set();
	_changed();
}

module.exports = {
	isPdfDevice,
	matchesService,
	findService,
	rebuild,
	enqueue,
	setSpoolId,
	dequeue,
	dropJob,
	loadOf,
	reconcile,
	choosePrinter,
	leastLoaded,
	getSnapshot,
	getDeviceLoads,
	hasAutoRoute,
	setChangeNotifier,
	reset,
};
