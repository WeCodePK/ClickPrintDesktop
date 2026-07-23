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

	// Jobs — the list is pushed authoritatively from main; operator actions are
	// commands handled entirely by the main-process print engine.
	fetchJobs: () => ipcRenderer.invoke("jobs:fetch"),
	fetchHistory: () => ipcRenderer.invoke("history:fetch"),
	declineJob: (jobId) => ipcRenderer.invoke("jobs:decline", jobId),
	completeJob: (jobId, opts) => ipcRenderer.invoke("jobs:complete", jobId, opts),
	// Operator "mark as failed" via the per-document failure banner. The customer
	// is refunded on the backend for a "failed" status.
	markJobFailed: (jobId) => ipcRenderer.invoke("jobs:mark-failed", jobId),
	onJobsUpdate: (callback) => {
		const handler = (_event, jobs) => callback(jobs);
		ipcRenderer.on("jobs:updated", handler);
		return () => ipcRenderer.removeListener("jobs:updated", handler);
	},

	// Print engine — consolidated state snapshot + commands. All orchestration
	// (routing, queueing, spooler verification, backend transitions) is in main.
	getEngineState: () => ipcRenderer.invoke("engine:get-state"),
	onEngineState: (callback) => {
		const handler = (_event, snapshot) => callback(snapshot);
		ipcRenderer.on("engine:state", handler);
		return () => ipcRenderer.removeListener("engine:state", handler);
	},
	// Semantic notification events (renderer owns the copy).
	onEngineToast: (callback) => {
		const handler = (_event, payload) => callback(payload);
		ipcRenderer.on("engine:toast", handler);
		return () => ipcRenderer.removeListener("engine:toast", handler);
	},
	printJob: (jobId, deviceName) => ipcRenderer.invoke("engine:print-job", jobId, deviceName),
	printJobFile: (jobId, fileId, deviceName) => ipcRenderer.invoke("engine:print-file", jobId, fileId, deviceName),
	setQueuePaused: (paused) => ipcRenderer.invoke("engine:set-paused", paused),
	setAutoPrint: (enabled) => ipcRenderer.invoke("engine:set-autoprint", enabled),
	resolveRequeue: (accept) => ipcRenderer.invoke("engine:requeue-decision", accept),
	refreshRouting: () => ipcRenderer.invoke("engine:refresh-routing"),
	migratePrintProgress: (printedFiles) => ipcRenderer.invoke("engine:migrate-progress", printedFiles),

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

	// Shop printers (registered on the backend)
	fetchPrinters: () => ipcRenderer.invoke("printers:fetch"),
	createPrinter: (name) => ipcRenderer.invoke("printers:create", name),
	deletePrinter: (printerId) => ipcRenderer.invoke("printers:delete", printerId),
	setPrinterDisabled: (printerId, isDisabled) => ipcRenderer.invoke("printers:setDisabled", printerId, isDisabled),

	// Local printers (reachable right now on this machine)
	listPrinters: (force) => ipcRenderer.invoke("printers:list", force),
	// All installed printers (online + offline) for the add-printer picker
	listAllPrinters: (force) => ipcRenderer.invoke("printers:list-all", force),
	testPrinter: (deviceName) => ipcRenderer.invoke("printers:test", deviceName),

	// Shop
	updateShop: (shopId, data) => ipcRenderer.invoke("shop:update", shopId, data),

	// Shop profile
	fetchShop: () => ipcRenderer.invoke("shop:fetch"),

	// Shop services (priced print configurations)
	fetchServices: () => ipcRenderer.invoke("services:fetch"),
	createService: (service) => ipcRenderer.invoke("services:create", service),
	updateService: (serviceId, service) => ipcRenderer.invoke("services:update", serviceId, service),
	deleteService: (serviceId) => ipcRenderer.invoke("services:delete", serviceId),
	setServiceDisabled: (serviceId, isDisabled) => ipcRenderer.invoke("services:setDisabled", serviceId, isDisabled),

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