const { ipcMain } = require("electron");
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
	markJobFailed,
	isJobFailing,
	acknowledgeNewJobs,
	startJobsSse,
	stopJobsSse,
	setSseStatusNotifier,
	getSseStatus,
} = require("./api");
const { syncJobFiles, getStatusMap, setNotifier, openFile } = require("./files");
const { listPrinters, listAllPrinters, printTestPage } = require("./printers");
const { getJobs } = require("./state");
const engine = require("./printEngine");

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
	// must never surface).
	const pushJobs = (jobs) => {
		const visible = engine.applyOverrides(jobs || []).filter((j) => !isJobFailing(j._id));
		console.log(`[IPC] Pushing jobs:updated — ${visible.length} jobs`);
		send("jobs:updated", visible);
	};

	// A job whose file download failed unrecoverably is marked "failed" on the
	// backend (the customer is refunded there) and dropped from the engine.
	const handleJobFailed = async (jobId) => {
		const job = getJobs().find((j) => j._id === jobId);
		const result = await markJobFailed(jobId, job?.status);
		if (!result?.success) return false; // let the next reconcile retry
		engine.dropJob(jobId);
		send("engine:toast", {
			kind: "job-failed-download",
			jobId,
			who: job?.createdBy?.name || job?.createdBy?.number || `#${String(jobId).slice(-6)}`,
		});
		return true;
	};

	// Starts the live jobs SSE stream, the print engine, and pushes every update
	// to the renderer. Shared by fresh logins and restored sessions.
	const beginJobsSync = () => {
		engine.start();
		startJobsSse((jobs) => {
			pushJobs(jobs);
			// Acknowledge new jobs to the backend and download their files.
			acknowledgeNewJobs(jobs);
			syncJobFiles(jobs, handleJobFailed);
			// Feed the engine last — downloads are already kicking off.
			engine.onJobsReconciled(jobs);
		});
	};

	// Push per-file download status updates to the renderer as they happen.
	setNotifier((updates) => {
		const win = getMainWindow();
		if (win && !win.isDestroyed()) {
			win.webContents.send("files:updated", updates);
		}
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
		clearAuthState();
		return { success: true };
	});

	ipcMain.handle("shop:update", async (_event, shopId, data) => {
		console.log("[IPC] shop:update →", shopId);
		return await updateShop(shopId, data);
	});

	ipcMain.handle("jobs:fetch", async () => {
		console.log("[IPC] jobs:fetch");
		const result = await fetchJobs();
		// On initial load / reload, acknowledge new jobs and cache their files.
		if (result.success) {
			acknowledgeNewJobs(result.data);
			syncJobFiles(result.data, handleJobFailed);
			// Hide any jobs mid-transition to "failed" (see beginJobsSync) and apply
			// the engine's local status overrides.
			return { ...result, data: engine.applyOverrides(result.data).filter((j) => !isJobFailing(j._id)) };
		}
		return result;
	});

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

	ipcMain.handle("files:open", async (_event, fileId) => {
		console.log(`[IPC] files:open → ${fileId}`);
		try {
			await openFile(fileId);
			return { success: true };
		} catch (error) {
			console.error(`[IPC] files:open ${fileId} error:`, error.message);
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

	// ── Print engine (all orchestration/state lives in main) ───────────────────
	ipcMain.handle("engine:get-state", async () => {
		return engine.getSnapshot();
	});

	ipcMain.handle("engine:print-job", async (_event, jobId, deviceName) => {
		console.log(`[IPC] engine:print-job → ${jobId}${deviceName ? ` (@${deviceName})` : ""}`);
		return engine.printJob(jobId, deviceName || null);
	});

	ipcMain.handle("engine:print-file", async (_event, jobId, fileId, deviceName) => {
		console.log(`[IPC] engine:print-file → ${jobId}:${fileId}${deviceName ? ` (@${deviceName})` : ""}`);
		return engine.printFile(jobId, fileId, deviceName || null);
	});

	ipcMain.handle("engine:set-paused", async (_event, paused) => {
		console.log("[IPC] engine:set-paused →", !!paused);
		return engine.setPaused(paused);
	});

	ipcMain.handle("engine:set-autoprint", async (_event, enabled) => {
		console.log("[IPC] engine:set-autoprint →", !!enabled);
		return engine.setAutoPrint(enabled);
	});

	ipcMain.handle("engine:requeue-decision", async (_event, accept) => {
		console.log("[IPC] engine:requeue-decision →", !!accept);
		return engine.resolveRequeue(!!accept);
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