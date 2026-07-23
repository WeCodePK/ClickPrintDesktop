const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
	// Auth
	sendOtp: (number) => ipcRenderer.invoke("auth:send-otp", number),
	verifyOtp: (code, number) =>
		ipcRenderer.invoke("auth:verify-otp", code, number),
	// Records which shop (of possibly several the user owns) to operate as; this
	// is what actually starts the shop-scoped jobs stream. `shop` is { _id, name }.
	// Chosen once at login — switching shops mid-session isn't supported (log out
	// and back in to change shops).
	selectShop: (shop) => ipcRenderer.invoke("auth:select-shop", shop),
	getAuthState: () => ipcRenderer.invoke("auth:get-state"),
	logout: () => ipcRenderer.invoke("auth:logout"),

	// Live jobs-stream (SSE) connection state — "connecting" | "open" |
	// "reconnecting" | "closed". Query the current value, and subscribe to changes.
	getSseStatus: () => ipcRenderer.invoke("sse:get-status"),
	onSseStatus: (callback) => {
		const handler = (_event, status) => callback(status);
		ipcRenderer.on("sse:status", handler);
		return () => ipcRenderer.removeListener("sse:status", handler);
	},

	// Jobs
	fetchJobs: () => ipcRenderer.invoke("jobs:fetch"),
	fetchHistory: () => ipcRenderer.invoke("history:fetch"),
	updateJobStatus: (jobId, status) => ipcRenderer.invoke("jobs:update-status", jobId, status),
	// Marks a job "failed" — every document failed to print (or the operator
	// forced it from the per-document failure banner). The customer is refunded
	// on the backend for a "failed" status.
	markJobFailed: (jobId, currentStatus) => ipcRenderer.invoke("jobs:mark-failed", jobId, currentStatus),
	onJobsUpdate: (callback) => {
		const handler = (_event, jobs) => callback(jobs);
		ipcRenderer.on("jobs:updated", handler);
		return () => ipcRenderer.removeListener("jobs:updated", handler);
	},
	// Fired when a job is marked failed — its file download failed unrecoverably,
	// or every document failed to print. `reason` is "download" or "print".
	onJobFailed: (callback) => {
		const handler = (_event, jobId, reason) => callback(jobId, reason);
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
	printFile: (fileId, settings, deviceName, fileName) => ipcRenderer.invoke("files:print", fileId, settings, deviceName, fileName),

	// Shop printers (registered on the backend)
	fetchPrinters: () => ipcRenderer.invoke("printers:fetch"),
	createPrinter: (name) => ipcRenderer.invoke("printers:create", name),
	deletePrinter: (printerId) => ipcRenderer.invoke("printers:delete", printerId),

	// Local printers (reachable right now on this machine)
	listPrinters: (force) => ipcRenderer.invoke("printers:list", force),
	// All installed printers (online + offline) for the add-printer picker
	listAllPrinters: (force) => ipcRenderer.invoke("printers:list-all", force),
	testPrinter: (deviceName) => ipcRenderer.invoke("printers:test", deviceName),
	getSelectedPrinter: () => ipcRenderer.invoke("printers:get-selected"),
	setSelectedPrinter: (printer) => ipcRenderer.invoke("printers:set-selected", printer),

	// Automated printing toggle (persisted in the main-process store)
	getAutoPrint: () => ipcRenderer.invoke("settings:get-autoprint"),
	setAutoPrint: (enabled) => ipcRenderer.invoke("settings:set-autoprint", enabled),

	// Shop
	updateShop: (shopId, data) => ipcRenderer.invoke("shop:update", shopId, data),

	// Shop profile
	fetchShop: () => ipcRenderer.invoke("shop:fetch"),

	// Shop services (priced print configurations)
	fetchServices: () => ipcRenderer.invoke("services:fetch"),
	createService: (service) => ipcRenderer.invoke("services:create", service),
	updateService: (serviceId, service) => ipcRenderer.invoke("services:update", serviceId, service),
	deleteService: (serviceId) => ipcRenderer.invoke("services:delete", serviceId),

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