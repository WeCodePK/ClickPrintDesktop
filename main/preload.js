const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
	// Auth
	sendOtp: (number) => ipcRenderer.invoke("auth:send-otp", number),
	verifyOtp: (code, number) =>
		ipcRenderer.invoke("auth:verify-otp", code, number),
	getAuthState: () => ipcRenderer.invoke("auth:get-state"),
	logout: () => ipcRenderer.invoke("auth:logout"),

	// Jobs
	fetchJobs: () => ipcRenderer.invoke("jobs:fetch"),
	fetchHistory: () => ipcRenderer.invoke("history:fetch"),
	updateJobStatus: (jobId, status) => ipcRenderer.invoke("jobs:update-status", jobId, status),
	onJobsUpdate: (callback) => {
		const handler = (_event, jobs) => callback(jobs);
		ipcRenderer.on("jobs:updated", handler);
		return () => ipcRenderer.removeListener("jobs:updated", handler);
	},
	// Fired when a job's file download fails unrecoverably and it was marked failed.
	onJobFailed: (callback) => {
		const handler = (_event, jobId) => callback(jobId);
		ipcRenderer.on("jobs:file-failed", handler);
		return () => ipcRenderer.removeListener("jobs:file-failed", handler);
	},

	// Files (downloaded + cached in the main process)
	getFilesStatus: () => ipcRenderer.invoke("files:status"),
	onFilesUpdate: (callback) => {
		const handler = (_event, updates) => callback(updates);
		ipcRenderer.on("files:updated", handler);
		return () => ipcRenderer.removeListener("files:updated", handler);
	},
	// URL the renderer can embed to view a cached file.
	fileUrl: (fileId) => `clickfile://file/${fileId}`,
	// Open a cached file in the OS default viewer / native print dialog.
	openFile: (fileId) => ipcRenderer.invoke("files:open", fileId),
	// Removes cached files for a job once it reaches a terminal state.
	deleteJobFiles: (fileIds) => ipcRenderer.invoke("files:delete-job-files", fileIds),
	printFile: (fileId, settings, deviceName) => ipcRenderer.invoke("files:print", fileId, settings, deviceName),

	// Shop printers (registered on the backend)
	fetchPrinters: () => ipcRenderer.invoke("printers:fetch"),
	createPrinter: (name) => ipcRenderer.invoke("printers:create", name),
	deletePrinter: (printerId) => ipcRenderer.invoke("printers:delete", printerId),

	// Local printers (reachable right now on this machine)
	listPrinters: (force) => ipcRenderer.invoke("printers:list", force),
	testPrinter: (deviceName) => ipcRenderer.invoke("printers:test", deviceName),
	getSelectedPrinter: () => ipcRenderer.invoke("printers:get-selected"),
	setSelectedPrinter: (printer) => ipcRenderer.invoke("printers:set-selected", printer),

	// Automated printing toggle (persisted in the main-process store)
	getAutoPrint: () => ipcRenderer.invoke("settings:get-autoprint"),
	setAutoPrint: (enabled) => ipcRenderer.invoke("settings:set-autoprint", enabled),

	// Shop
	updateShop: (shopId, data) => ipcRenderer.invoke("shop:update", shopId, data),

	// Shop pricing
	fetchPrices: () => ipcRenderer.invoke("prices:fetch"),
	createPrice: (price) => ipcRenderer.invoke("prices:create", price),
	updatePrice: (priceId, price) => ipcRenderer.invoke("prices:update", priceId, price),
	deletePrice: (priceId) => ipcRenderer.invoke("prices:delete", priceId),

	// Window controls
	minimizeWindow: () => ipcRenderer.send("window:minimize"),
	maximizeWindow: () => ipcRenderer.send("window:maximize"),
	closeWindow: () => ipcRenderer.send("window:close"),

	// Auto-update
	getAppVersion: () => ipcRenderer.invoke("app:get-version"),
	getUpdateStatus: () => ipcRenderer.invoke("app:get-update-status"),
	restartToUpdate: () => ipcRenderer.send("app:restart-to-update"),
	onUpdateStatus: (callback) => {
		const handler = (_event, status) => callback(status);
		ipcRenderer.on("updater:status", handler);
		return () => ipcRenderer.removeListener("updater:status", handler);
	},
});