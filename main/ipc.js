const { ipcMain } = require("electron");
const {
	sendOtp,
	verifyOtp,
	updateShop,
	getAuthState,
	clearAuthState,
	fetchPrices,
	createPrice,
	updatePrice,
	deletePrice,
	fetchPrinters,
	createPrinter,
	deletePrinter,
	fetchJobs,
	fetchHistory,
	updateJobStatus,
	markJobFailed,
	isJobFailing,
	acknowledgeNewJobs,
	startJobsSse,
	stopJobsSse,
} = require("./api");
const { syncJobFiles, getStatusMap, setNotifier, openFile, printFile, deleteJobFiles } = require("./files");
const { listPrinters, listAllPrinters, printTestPage } = require("./printers");
const store = require("./store");

function registerIpcHandlers(getMainWindow) {
	// A job with an unrecoverable file download is marked "failed" on the backend
	// and the renderer is told so it can drop it from the list/queue at once.
	const handleJobFilesFailed = async (jobId) => {
		const result = await markJobFailed(jobId);
		if (!result?.success) return false; // let the next reconcile retry
		const win = getMainWindow();
		if (win && !win.isDestroyed()) win.webContents.send("jobs:file-failed", jobId);
		return true;
	};

	// Starts the live jobs SSE stream and pushes every update to the renderer.
	// Shared by fresh logins (auth:verify-otp) and restored sessions (startup).
	const beginJobsSync = () => {
		startJobsSse((jobs) => {
			const win = getMainWindow();
			// Hide jobs mid-transition to "failed" so their forced "printing" step
			// never surfaces in the UI (they're removed via jobs:file-failed).
			const visible = jobs.filter((j) => !isJobFailing(j._id));
			console.log(`[IPC] Pushing jobs:updated — ${visible.length} jobs, window=${win ? "open" : "null"}`);
			if (win && !win.isDestroyed()) {
				win.webContents.send("jobs:updated", visible);
			}
			// Acknowledge new jobs to the backend and download their files.
			acknowledgeNewJobs(jobs);
			syncJobFiles(jobs, handleJobFilesFailed);
		});
	};

	// Push per-file download status updates to the renderer as they happen.
	setNotifier((updates) => {
		const win = getMainWindow();
		if (win && !win.isDestroyed()) {
			win.webContents.send("files:updated", updates);
		}
	});

	ipcMain.handle("auth:send-otp", async (_event, number) => {
		console.log("[IPC] auth:send-otp →", number);
		return await sendOtp(number);
	});

	ipcMain.handle("auth:verify-otp", async (_event, code, number) => {
		console.log("[IPC] auth:verify-otp →", number);
		const result = await verifyOtp(code, number);
		if (result.success) {
			// Start the SSE connection now that we have a token. On every reconnect
			// or event the main process re-fetches the full job list and pushes it
			// to the renderer — renderer is never stale.
			beginJobsSync();
		}
		return result;
	});

	ipcMain.handle("auth:get-state", async () => {
		return getAuthState();
	});

	ipcMain.handle("auth:logout", async () => {
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
			syncJobFiles(result.data, handleJobFilesFailed);
			// Hide any jobs mid-transition to "failed" (see beginJobsSync).
			return { ...result, data: result.data.filter((j) => !isJobFailing(j._id)) };
		}
		return result;
	});

	ipcMain.handle("history:fetch", async () => {
		console.log("[IPC] history:fetch");
		return await fetchHistory();
	});

	ipcMain.handle("prices:fetch", async () => {
		console.log("[IPC] prices:fetch");
		return await fetchPrices();
	});

	ipcMain.handle("prices:create", async (_event, price) => {
		console.log("[IPC] prices:create →", price?.name);
		return await createPrice(price);
	});

	ipcMain.handle("prices:update", async (_event, priceId, price) => {
		console.log("[IPC] prices:update →", priceId);
		return await updatePrice(priceId, price);
	});

	ipcMain.handle("prices:delete", async (_event, priceId) => {
		console.log("[IPC] prices:delete →", priceId);
		return await deletePrice(priceId);
	});

	ipcMain.handle("jobs:update-status", async (_event, jobId, status) => {
		console.log(`[IPC] jobs:update-status → ${jobId} = ${status}`);
		return await updateJobStatus(jobId, status);
	});

	ipcMain.handle("files:status", async () => {
		return getStatusMap();
	});

	ipcMain.handle("files:delete-job-files", async (_event, fileIds) => {
		console.log(`[IPC] files:delete-job-files → ${(fileIds || []).length} file(s)`);
		try {
			await deleteJobFiles(fileIds);
			return { success: true };
		} catch (error) {
			console.error("[IPC] files:delete-job-files error:", error.message);
			return { success: false, message: error.message };
		}
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

	ipcMain.handle("files:print", async (_event, fileId, settings, deviceName) => {
		console.log(`[IPC] files:print → ${fileId}${deviceName ? ` (@${deviceName})` : ""}`);
		try {
			await printFile(fileId, settings, deviceName);
			return { success: true };
		} catch (error) {
			console.error(`[IPC] files:print ${fileId} error:`, error.message);
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

	ipcMain.handle("printers:get-selected", async () => {
		return store.get("selectedPrinter") || null;
	});

	ipcMain.handle("printers:set-selected", async (_event, printer) => {
		console.log("[IPC] printers:set-selected →", printer?.name);
		store.set("selectedPrinter", printer);
		return { success: true };
	});

	// ── Automated printing toggle (persisted) ──────────────────────────────────
	ipcMain.handle("settings:get-autoprint", async () => {
		return store.get("autoPrint") === true;
	});

	ipcMain.handle("settings:set-autoprint", async (_event, enabled) => {
		console.log("[IPC] settings:set-autoprint →", !!enabled);
		store.set("autoPrint", !!enabled);
		return { success: true };
	});

	// If a session was restored from disk on startup, begin syncing jobs right
	// away so the dashboard is live without requiring a fresh login.
	if (getAuthState().token) {
		console.log("[IPC] Restoring session — starting jobs sync");
		beginJobsSync();
	}
}

module.exports = { registerIpcHandlers };