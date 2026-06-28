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

	// Files (downloaded + cached in the main process)
	getFilesStatus: () => ipcRenderer.invoke("files:status"),
	onFilesUpdate: (callback) => {
		const handler = (_event, updates) => callback(updates);
		ipcRenderer.on("files:updated", handler);
		return () => ipcRenderer.removeListener("files:updated", handler);
	},
	// URL the renderer can embed to view a cached file.
	fileUrl: (fileId) => `clickfile://file/${fileId}`,

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
});