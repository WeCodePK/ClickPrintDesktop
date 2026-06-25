const { ipcMain } = require("electron");
const { sendOtp, verifyOtp, updateShop, fetchJobs } = require("./api");

ipcMain.handle("api:sendOtp", async (event, { number }) => await sendOtp(number));
ipcMain.handle("api:verifyOtp", async (event, opts) => await sendOtp(opts));


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
			});
		}
		return result;
	});

function registerIpcHandlers(getMainWindow) {




	ipcMain.handle("auth:get-state", async () => {
		return getAuth();
	});

	ipcMain.handle("auth:logout", async () => {
		stopJobsSse();
		clearAuth();
		return { success: true };
	});

	ipcMain.handle("shop:update", async (_event, shopId, data) => {
		console.log("[IPC] shop:update →", shopId);
		return await updateShop(shopId, data);
	});

	ipcMain.handle("jobs:fetch", async () => {
		console.log("[IPC] jobs:fetch");
		return await fetchJobs();
	});
}

module.exports = { registerIpcHandlers };
