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
	fetchJobs,
	fetchHistory,
	updateJobStatus,
	acknowledgeNewJobs,
	startJobsSse,
	stopJobsSse,
} = require("./api");
const { syncJobFiles, getStatusMap, setNotifier } = require("./files");

function registerIpcHandlers(getMainWindow) {
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
			// Start the SSE connection now that we have a token.
			// On every reconnect or event the main process re-fetches the full
			// job list and pushes it to the renderer — renderer is never stale.
			startJobsSse((jobs) => {
				const win = getMainWindow();
				console.log(`[IPC] Pushing jobs:updated — ${jobs.length} jobs, window=${win ? "open" : "null"}`);
				if (win && !win.isDestroyed()) {
					win.webContents.send("jobs:updated", jobs);
				}
				// Acknowledge new jobs to the backend and download their files.
				acknowledgeNewJobs(jobs);
				syncJobFiles(jobs);
			});
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
			syncJobFiles(result.data);
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
}

module.exports = { registerIpcHandlers };