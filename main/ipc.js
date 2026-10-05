const { ipcMain, app, shell } = require("electron");
const {
	sendOtp,
	verifyOtp,
	selectShop,
	updateShop,
	getAuthState,
	clearAuthState,
	fetchShop,
	fetchServices,
	createService,
	updateService,
	deleteService,
	setServiceDisabled,
	fetchPrinters,
	createPrinter,
	deletePrinter,
	setPrinterDisabled,
	fetchJobs,
	fetchHistory,
	cachedCopy,
	clearCaches,
	isJobFailing,
	startJobsSse,
	stopJobsSse,
	resync,
	setSseStatusNotifier,
	setPingNotifier,
	setWhatsAppSendHandler,
	setJobCompletedHandler,
	getSseStatus,
	getShopId,
} = require("./api");
const { syncJobFiles, retryAll: retryDownloads, getStatusMap, setNotifier, openFile, getRawFileInfo, redownloadFile, ensureProof, openProof, openJobFolder } = require("./files");
const { listPrinters, listAllPrinters, printTestPage, getPrinterDetails } = require("./printers");
const { getJobs, setJobs } = require("./state");
const engine = require("./printEngine");
const whatsapp = require("./whatsapp");
const outbox = require("./outbox");
const connectivity = require("./connectivity");
const http = require("./http");

const TERMINAL_STATUSES = new Set(["completed", "cancelled", "failed"]);

function registerIpcHandlers(getMainWindow) {
	const send = (channel, ...args) => {
		const win = getMainWindow();
		if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
	};

	// The print engine owns all orchestration; ipc just wires its outputs to the
	// renderer (state snapshots, semantic toast events, refreshed job pushes).
	engine.init({
		getMainWindow,
		onSnapshot: (snapshot) => send("engine:state", snapshot),
		onToast: (payload) => send("engine:toast", payload),
		onJobsChanged: () => pushJobs(getJobs()),
	});

	// Pushes a job list to the renderer with the engine's locally-known status
	// transitions applied and mid-fail jobs hidden (their forced "printing" step
	// must never surface). `meta` is { stale, fetchedAt } when the list is the
	// cached copy rather than a fresh one.
	let lastMeta = { stale: false, fetchedAt: null };
	const pushJobs = (jobs, meta = lastMeta) => {
		lastMeta = meta;
		const visible = engine.applyOverrides(jobs || []).filter((j) => !isJobFailing(j._id));
		console.log(`[IPC] Pushing jobs:updated — ${visible.length} jobs${meta.stale ? " (cached)" : ""}`);
		send("jobs:updated", visible, meta);
	};

	// Acknowledges receipt of new jobs (submitted → queued) through the outbox,
	// so an ack made while offline lands once the backend is reachable.
	const acknowledgeNewJobs = (jobs) => {
		for (const job of engine.applyOverrides(jobs || [])) {
			if (job.status !== "submitted" || outbox.hasPending(job._id) || outbox.wasApplied(job._id, "queued")) continue;
			outbox.enqueue(job._id, "queued");
		}
	};

	// Downloads files only for jobs still open locally — one printed (or
	// cancelled) offline is done, even while the backend's copy says otherwise.
	const syncOpenJobFiles = (jobs) => {
		syncJobFiles(engine.applyOverrides(jobs || []).filter((j) => !TERMINAL_STATUSES.has(j.status)));
	};

	// A job list from the backend (or its cached copy) drives everything.
	const handleJobs = (jobs, meta) => {
		pushJobs(jobs, meta);
		// Acknowledge new jobs to the backend and download their files.
		acknowledgeNewJobs(jobs);
		syncOpenJobFiles(jobs);
		// Feed the engine last — downloads are already kicking off.
		engine.onJobsReconciled(jobs);
	};

	// Starts the live jobs SSE stream, the print engine, and pushes every update
	// to the renderer. Shared by fresh logins and restored sessions. The last
	// cached job list is loaded first, so a launch with no connection still
	// shows (and can print) the jobs the shop already had.
	const beginJobsSync = () => {
		engine.start();
		// Reconnects an already-linked WhatsApp for this shop (unlinked ones wait
		// for the operator to press Connect in the WhatsApp drawer).
		whatsapp.start(getShopId());
		const cached = cachedCopy("jobs");
		if (cached && Array.isArray(cached.data) && getJobs().length === 0) {
			console.log(`[IPC] loaded ${cached.data.length} cached job(s) from ${cached.fetchedAt}`);
			setJobs(cached.data);
			handleJobs(cached.data, { stale: true, fetchedAt: cached.fetchedAt });
		}
		void outbox.flush();
		startJobsSse((jobs) => handleJobs(jobs, { stale: false, fetchedAt: new Date().toISOString() }));
	};

	// ── Connectivity ──────────────────────────────────────────────────────────
	// The offline banner, and everything queued while offline, hang off this.
	const netStatus = () => ({ ...connectivity.snapshot(), pendingSync: outbox.summary().total });
	connectivity.onChange(() => send("net:status", netStatus()));
	// While offline: a cheap authenticated request, so coming back is noticed.
	connectivity.setProbe(async () => {
		const { token } = getAuthState();
		const shopId = getShopId();
		if (!token || !shopId) return;
		await http.request("GET", `/api/shops/${shopId}`, { headers: { Authorization: `Bearer ${token}` }, timeoutMs: 5000 });
	});
	// Back online: catch up in order — the job list first, then everything that
	// was queued while offline.
	connectivity.onOnline(() => {
		resync();
		void outbox.flush();
		retryDownloads();
		whatsapp.onOnline();
	});
	outbox.setChangeListener(() => {
		send("net:status", netStatus());
		engine.notifyChanged();
	});
	// A job printed offline that the customer cancelled (or that failed) in the
	// meantime: the backend's status stands; the operator needs to know.
	outbox.setConflictHandler((jobId, status) => {
		const job = getJobs().find((j) => j._id === jobId);
		send("engine:toast", { kind: "printed-offline-conflict", jobId, status, who: engine.jobWho(job || { _id: jobId }) });
		pushJobs(getJobs());
	});

	ipcMain.handle("net:get-status", () => netStatus());
	// The banner's "Retry now": check the connection without waiting out the backoff.
	ipcMain.handle("net:check-now", () => {
		connectivity.checkNow();
		return netStatus();
	});
	// Development only: simulate a bad network ("offline", "flaky:0.5", "latency:3000").
	ipcMain.handle("dev:set-net-fault", (_event, spec) => (app.isPackaged ? null : http.setFault(spec)));

	// Push per-file download status updates to the renderer as they happen.
	setNotifier((updates) => {
		const win = getMainWindow();
		if (win && !win.isDestroyed()) {
			win.webContents.send("files:updated", updates);
		}
	});

	// Every SSE ping (~5s) sweeps each printer's spool queue: finished/failed
	// documents leave the registry and foreign load is re-counted, keeping load
	// balancing honest.
	setPingNotifier(() => engine.reconcilePrinterQueues());

	// WhatsApp: link-state pushes drive the sidebar dot and drawer; the backend's
	// "whatsappSend" SSE events go straight out through the linked socket.
	whatsapp.setNotifier((snapshot) => send("whatsapp:status", snapshot));
	setWhatsAppSendHandler((payload) => whatsapp.sendText(payload));
	setJobCompletedHandler((job) => whatsapp.notifyJobReady(job));
	whatsapp.setJobActions({
		withStatuses: (jobs) => engine.applyOverrides(jobs),
		cancelJob: (job) => engine.declineJob(job._id, { job }),
	});

	// Push live SSE connection-state changes to the renderer (drives the
	// connection indicator next to the settings/logout icons).
	setSseStatusNotifier((status) => {
		const win = getMainWindow();
		if (win && !win.isDestroyed()) {
			win.webContents.send("sse:status", status);
		}
	});

	ipcMain.handle("auth:send-otp", async (_event, number) => {
		console.log("[IPC] auth:send-otp →", number);
		return await sendOtp(number);
	});

	ipcMain.handle("auth:verify-otp", async (_event, code, number) => {
		console.log("[IPC] auth:verify-otp →", number);
		// Verify only authenticates and returns the user's shops. We can't start the
		// (shop-scoped) SSE stream yet — that waits until a shop is chosen, in
		// auth:select-shop below.
		return await verifyOtp(code, number);
	});

	// The user picked which of their shops to operate as. Store it, then start the
	// SSE connection now that we have both a token and a shop. On every reconnect
	// or event the main process re-fetches the full job list and pushes it to the
	// renderer — renderer is never stale.
	ipcMain.handle("auth:select-shop", async (_event, shop) => {
		console.log("[IPC] auth:select-shop →", shop?._id);
		const result = selectShop(shop);
		if (result.success) {
			outbox.resumeAuth();
			beginJobsSync();
		}
		return result;
	});

	// Current SSE connection state, for a renderer that mounts after the stream is
	// already up (the live sse:status events would otherwise have been missed).
	ipcMain.handle("sse:get-status", async () => {
		return getSseStatus();
	});

	ipcMain.handle("auth:get-state", async () => {
		return getAuthState();
	});

	ipcMain.handle("auth:logout", async () => {
		engine.stop();
		stopJobsSse();
		whatsapp.disconnect();
		clearAuthState();
		// Cached shop data belongs to this account. Status transitions still
		// waiting to sync stay queued: they record printing that really happened,
		// and replay when this shop signs in again.
		await clearCaches();
		return { success: true };
	});

	ipcMain.handle("shop:update", async (_event, shopId, data) => {
		console.log("[IPC] shop:update →", shopId);
		return await updateShop(shopId, data);
	});

	ipcMain.handle("jobs:fetch", async () => {
		console.log("[IPC] jobs:fetch");
		// A failed fetch falls back to the cached list (marked stale) — see api.js.
		const result = await fetchJobs();
		// On initial load / reload, acknowledge new jobs and cache their files.
		if (result.success) {
			// The engine looks jobs up in main's copy, which the SSE stream otherwise
			// only fills once it connects — without this, every print and settings
			// command fails with "job not found" while the stream is down. A stale
			// copy never replaces a fresher list main already has.
			if (!result.stale || getJobs().length === 0) setJobs(result.data);
			acknowledgeNewJobs(result.data);
			syncOpenJobFiles(result.data);
			// Hide any jobs mid-transition to "failed" (see beginJobsSync) and apply
			// the engine's local status overrides.
			return { ...result, data: engine.applyOverrides(result.data).filter((j) => !isJobFailing(j._id)) };
		}
		return result;
	});

	// A failed fetch (offline, server down) falls back to the last good copy,
	// marked `stale` with the time it was fetched (see api.js), so the screens
	// keep showing data instead of an error.
	ipcMain.handle("history:fetch", async () => {
		console.log("[IPC] history:fetch");
		return await fetchHistory();
	});

	ipcMain.handle("shop:fetch", async () => {
		console.log("[IPC] shop:fetch");
		return await fetchShop();
	});

	ipcMain.handle("services:fetch", async () => {
		console.log("[IPC] services:fetch");
		return await fetchServices();
	});

	ipcMain.handle("services:create", async (_event, service) => {
		console.log("[IPC] services:create");
		return await createService(service);
	});

	ipcMain.handle("services:update", async (_event, serviceId, service) => {
		console.log("[IPC] services:update →", serviceId);
		return await updateService(serviceId, service);
	});

	ipcMain.handle("services:delete", async (_event, serviceId) => {
		console.log("[IPC] services:delete →", serviceId);
		return await deleteService(serviceId);
	});

	ipcMain.handle("services:setDisabled", async (_event, serviceId, isDisabled) => {
		console.log(`[IPC] services:setDisabled → ${serviceId} (${isDisabled})`);
		return await setServiceDisabled(serviceId, isDisabled);
	});

	// Operator actions on a job — all orchestration lives in the engine.
	ipcMain.handle("jobs:decline", async (_event, jobId) => {
		console.log(`[IPC] jobs:decline → ${jobId}`);
		return await engine.declineJob(jobId);
	});

	ipcMain.handle("jobs:complete", async (_event, jobId, opts) => {
		console.log(`[IPC] jobs:complete → ${jobId}${opts?.force ? " (force)" : ""}`);
		return await engine.completeJob(jobId, opts || {});
	});

	// Operator "mark as failed" via the per-document failure banner.
	ipcMain.handle("jobs:mark-failed", async (_event, jobId) => {
		console.log(`[IPC] jobs:mark-failed → ${jobId}`);
		return await engine.forceFailJob(jobId);
	});

	ipcMain.handle("files:status", async () => {
		return getStatusMap();
	});

	// Opens a document's PDF, or with { raw: true } the customer's original upload.
	ipcMain.handle("files:open", async (_event, fileId, opts) => {
		console.log(`[IPC] files:open → ${fileId}${opts?.raw ? " (original)" : ""}`);
		try {
			await openFile(fileId, { raw: !!opts?.raw });
			return { success: true };
		} catch (error) {
			console.error(`[IPC] files:open ${fileId} error:`, error.message);
			return { success: false, message: error.message };
		}
	});

	// Whether a document's original upload is on disk (non-PDF uploads only), and
	// its name — drives the Open button's "original" option.
	ipcMain.handle("files:raw-info", async (_event, fileId) => getRawFileInfo(fileId));

	// "View files": the job's folder (documents + payment proof) in Explorer.
	ipcMain.handle("files:open-job-folder", async (_event, jobId) => {
		console.log(`[IPC] files:open-job-folder → ${jobId}`);
		try {
			await openJobFolder(jobId);
			return { success: true };
		} catch (error) {
			console.error(`[IPC] files:open-job-folder ${jobId} error:`, error.message);
			return { success: false, message: error.message };
		}
	});

	// The preview's Reload: replace a cached copy that won't render. Progress
	// arrives on files:updated like any other download.
	ipcMain.handle("files:redownload", async (_event, fileId) => {
		console.log(`[IPC] files:redownload → ${fileId}`);
		return { success: await redownloadFile(fileId) };
	});

	// Payment proofs download with the rest of a job's files; these two exist for
	// the details pane — a manual retry after a failed download, and opening the
	// proof full-size in the OS viewer.
	ipcMain.handle("files:ensure-proof", async (_event, fileId) => {
		console.log(`[IPC] files:ensure-proof → ${fileId}`);
		return { success: await ensureProof(fileId) };
	});

	ipcMain.handle("files:open-proof", async (_event, fileId) => {
		console.log(`[IPC] files:open-proof → ${fileId}`);
		try {
			await openProof(fileId);
			return { success: true };
		} catch (error) {
			console.error(`[IPC] files:open-proof ${fileId} error:`, error.message);
			return { success: false, message: error.message };
		}
	});


	// ── Shop printers (registered on the backend) ─────────────────────────────
	ipcMain.handle("printers:fetch", async () => {
		console.log("[IPC] printers:fetch");
		return await fetchPrinters();
	});

	ipcMain.handle("printers:create", async (_event, name) => {
		console.log("[IPC] printers:create →", name);
		return await createPrinter(name);
	});

	ipcMain.handle("printers:delete", async (_event, printerId) => {
		console.log("[IPC] printers:delete →", printerId);
		return await deletePrinter(printerId);
	});

	ipcMain.handle("printers:setDisabled", async (_event, printerId, isDisabled) => {
		console.log(`[IPC] printers:setDisabled → ${printerId} (${isDisabled})`);
		return await setPrinterDisabled(printerId, isDisabled);
	});

	// ── Local printers (what this machine can reach right now) ────────────────
	ipcMain.handle("printers:list", async (_event, force) => {
		try {
			const printers = await listPrinters(getMainWindow(), force);
			return { success: true, data: printers };
		} catch (error) {
			console.error("[IPC] printers:list error:", error.message);
			return { success: false, message: error.message, data: [] };
		}
	});

	// All installed printers (online + offline) for the add-printer picker.
	ipcMain.handle("printers:list-all", async (_event, force) => {
		try {
			const printers = await listAllPrinters(getMainWindow(), force);
			return { success: true, data: printers };
		} catch (error) {
			console.error("[IPC] printers:list-all error:", error.message);
			return { success: false, message: error.message, data: [] };
		}
	});

	// What Windows reports about one printer (port, driver, configuration…);
	// data is null when it isn't installed on this machine.
	ipcMain.handle("printers:details", async (_event, name) => {
		return { success: true, data: await getPrinterDetails(name) };
	});

	ipcMain.handle("printers:test", async (_event, deviceName) => {
		console.log(`[IPC] printers:test → ${deviceName}`);
		try {
			await printTestPage(deviceName);
			return { success: true };
		} catch (error) {
			console.error("[IPC] printers:test error:", error.message);
			return { success: false, message: error.message };
		}
	});

	// ── WhatsApp (linked-device socket lives in main) ──────────────────────────
	ipcMain.handle("whatsapp:get-status", async () => {
		return whatsapp.getSnapshot();
	});

	ipcMain.handle("whatsapp:connect", async () => {
		console.log("[IPC] whatsapp:connect");
		return await whatsapp.connect();
	});

	ipcMain.handle("whatsapp:unlink", async () => {
		console.log("[IPC] whatsapp:unlink");
		return await whatsapp.unlink();
	});

	ipcMain.handle("whatsapp:set-enabled", async (_event, enabled) => {
		console.log("[IPC] whatsapp:set-enabled", enabled);
		return whatsapp.setEnabled(!!enabled);
	});

	ipcMain.handle("whatsapp:set-flow", async (_event, flow) => {
		console.log("[IPC] whatsapp:set-flow", flow);
		return whatsapp.setFlow(String(flow));
	});

	ipcMain.handle("whatsapp:add-excluded-contact", async (_event, contact) => {
		return whatsapp.addExcludedContact(contact);
	});

	ipcMain.handle("whatsapp:remove-excluded-contact", async (_event, id) => {
		return whatsapp.removeExcludedContact(id);
	});

	// A customer's chat in the operator's own WhatsApp: the desktop app when one
	// handles whatsapp:// links, else wa.me in the browser (WhatsApp Web).
	ipcMain.handle("whatsapp:open-chat", async (_event, number) => {
		const phone = String(number || "").replace(/\D/g, "");
		if (!phone) return { success: false };
		if (app.getApplicationNameForProtocol("whatsapp://")) {
			try {
				await shell.openExternal(`whatsapp://send?phone=${phone}`);
				return { success: true };
			} catch (error) {
				console.error("[IPC] whatsapp:// open failed, using wa.me:", error.message);
			}
		}
		await shell.openExternal(`https://wa.me/${phone}`);
		return { success: true };
	});

	// ── Print engine (all orchestration/state lives in main) ───────────────────
	ipcMain.handle("engine:get-state", async () => {
		return engine.getSnapshot();
	});

	ipcMain.handle("engine:print-job", async (_event, jobId) => {
		console.log(`[IPC] engine:print-job → ${jobId}`);
		return engine.printJob(jobId);
	});

	// The operator's change to a document's print settings; `patch === null`
	// restores the customer's.
	ipcMain.handle("engine:set-file-settings", async (_event, jobId, docId, patch) => {
		console.log(`[IPC] engine:set-file-settings → ${jobId}:${docId}`, patch);
		return engine.setFileSettings(jobId, docId, patch ?? null);
	});

	ipcMain.handle("engine:print-file", async (_event, jobId, docId, deviceName) => {
		console.log(`[IPC] engine:print-file → ${jobId}:${docId}${deviceName ? ` (@${deviceName})` : ""}`);
		return engine.printFile(jobId, docId, deviceName || null);
	});

	// Stop a running print-all batch: queued documents are withdrawn, the one
	// currently at the printer finishes normally.
	ipcMain.handle("engine:stop-job", async (_event, jobId) => {
		console.log(`[IPC] engine:stop-job → ${jobId}`);
		return engine.stopJobBatch(jobId);
	});

	ipcMain.handle("engine:set-paused", async (_event, paused) => {
		console.log("[IPC] engine:set-paused →", !!paused);
		return engine.setPaused(paused);
	});

	ipcMain.handle("engine:set-autoprint", async (_event, enabled) => {
		console.log("[IPC] engine:set-autoprint →", !!enabled);
		return engine.setAutoPrint(enabled);
	});

	// Per-job automated-printing switch (holds only that job's auto queue).
	ipcMain.handle("engine:set-job-autopause", async (_event, jobId, paused) => {
		console.log(`[IPC] engine:set-job-autopause → ${jobId} (${!!paused})`);
		return engine.setJobAutoPaused(jobId, !!paused);
	});

	// Answer to "automated printing was on last session — resume it?".
	ipcMain.handle("engine:resume-decision", async (_event, accept) => {
		console.log("[IPC] engine:resume-decision →", !!accept);
		return engine.resolveResumePrompt(!!accept);
	});

	ipcMain.handle("engine:refresh-routing", async () => {
		await engine.refreshRouting(true);
		return { success: true };
	});

	// One-time import of the legacy renderer-localStorage print progress.
	ipcMain.handle("engine:migrate-progress", async (_event, printedFiles) => {
		engine.migrateProgress(printedFiles);
		return { success: true };
	});

	// If a session was restored from disk on startup, begin syncing jobs right
	// away so the dashboard is live without requiring a fresh login. Requires a
	// selected shop — the SSE stream is scoped to it.
	if (getAuthState().token && getAuthState().shopId) {
		console.log("[IPC] Restoring session — starting jobs sync");
		beginJobsSync();
	}
}

module.exports = { registerIpcHandlers };
