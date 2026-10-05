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

	// WhatsApp linked device — status snapshot { state, qr, me, error, enabled,
	// flow, excludedContacts } where state is "idle" | "connecting" | "qr" | "open" | "reconnecting"
	// | "logged_out". `qr` is a PNG data URL while waiting for a scan; `enabled` is
	// false while message handling is paused; `flow` is "menu" or "chat".
	getWhatsAppStatus: () => ipcRenderer.invoke("whatsapp:get-status"),
	onWhatsAppStatus: (callback) => {
		const handler = (_event, status) => callback(status);
		ipcRenderer.on("whatsapp:status", handler);
		return () => ipcRenderer.removeListener("whatsapp:status", handler);
	},
	connectWhatsApp: () => ipcRenderer.invoke("whatsapp:connect"),
	unlinkWhatsApp: () => ipcRenderer.invoke("whatsapp:unlink"),
	setWhatsAppEnabled: (enabled) => ipcRenderer.invoke("whatsapp:set-enabled", enabled),
	// "menu" | "chat": the ordering flow for this shop's new WhatsApp orders.
	setWhatsAppFlow: (flow) => ipcRenderer.invoke("whatsapp:set-flow", flow),
	addWhatsAppExcludedContact: (contact) => ipcRenderer.invoke("whatsapp:add-excluded-contact", contact),
	removeWhatsAppExcludedContact: (id) => ipcRenderer.invoke("whatsapp:remove-excluded-contact", id),
	openWhatsAppChat: (number) => ipcRenderer.invoke("whatsapp:open-chat", number),

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
	printJob: (jobId) => ipcRenderer.invoke("engine:print-job", jobId),
	printJobFile: (jobId, docId, deviceName) => ipcRenderer.invoke("engine:print-file", jobId, docId, deviceName),
	// Override a document's print settings (partial), or pass null to restore the
	// customer's. Resolves { success, message? }.
	setFileSettings: (jobId, docId, patch) => ipcRenderer.invoke("engine:set-file-settings", jobId, docId, patch),
	// Stop a running print-all batch (queued docs withdrawn; in-flight doc finishes).
	stopPrintJob: (jobId) => ipcRenderer.invoke("engine:stop-job", jobId),
	setQueuePaused: (paused) => ipcRenderer.invoke("engine:set-paused", paused),
	setAutoPrint: (enabled) => ipcRenderer.invoke("engine:set-autoprint", enabled),
	// Per-job automated-printing switch — pausing a job returns its manual print
	// controls so the operator can intervene.
	setJobAutoPaused: (jobId, paused) => ipcRenderer.invoke("engine:set-job-autopause", jobId, paused),
	// Answer the "resume automated printing?" prompt shown on launch when it was
	// armed in the previous session.
	resolveResumePrompt: (accept) => ipcRenderer.invoke("engine:resume-decision", accept),
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
	// Open a cached document in the OS default app: its PDF, or with
	// { raw: true } the customer's original upload.
	openFile: (fileId, opts) => ipcRenderer.invoke("files:open", fileId, opts),
	// { name, ext } of a document's original upload, or null when there is none
	// (the upload was already a PDF).
	getRawFileInfo: (fileId) => ipcRenderer.invoke("files:raw-info", fileId),
	// Replace a cached file with a fresh download (preview Reload).
	redownloadFile: (fileId) => ipcRenderer.invoke("files:redownload", fileId),
	// Open a job's folder of downloaded files in Windows Explorer.
	openJobFolder: (jobId) => ipcRenderer.invoke("files:open-job-folder", jobId),

	// A job's optional payment proof (the customer's transfer screenshot). It is
	// downloaded with the job's printing files, so its progress arrives on the same
	// `files:updated` channel, keyed by the proof's own file id.
	proofUrl: (fileId) => `clickfile://proof/${fileId}`,
	// Re-attempt a proof download that failed, or fetch one whose job has already
	// been cleaned up (History).
	ensureProof: (fileId) => ipcRenderer.invoke("files:ensure-proof", fileId),
	openProof: (fileId) => ipcRenderer.invoke("files:open-proof", fileId),

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
	getPrinterDetails: (name) => ipcRenderer.invoke("printers:details", name),

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
	// "auth" (compact, centred) while on the login screens; "app" (maximized) past them.
	setWindowMode: (mode) => ipcRenderer.send("window:set-mode", mode),
	maximizeWindow: () => ipcRenderer.send("window:maximize"),
	closeWindow: () => ipcRenderer.send("window:close"),

	// Auto-update — fully automatic (main/updater.js); the renderer only shows
	// progress. { state, version, percent }.
	getAppVersion: () => ipcRenderer.invoke("app:get-version"),
	getUpdateStatus: () => ipcRenderer.invoke("app:get-update-status"),
	onUpdateStatus: (callback) => {
		const handler = (_event, status) => callback(status);
		ipcRenderer.on("updater:status", handler);
		return () => ipcRenderer.removeListener("updater:status", handler);
	},
});
