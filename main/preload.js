const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("controls", {
	close: 	() => ipcRenderer.send("window:close"),
	maximize: () => ipcRenderer.send("window:maximize"),
	minimize: () => ipcRenderer.send("window:minimize")
});

contextBridge.exposeInMainWorld("api", {
	sendOtp: (opts) => ipcRenderer.invoke("api:sendOtp", opts),
	verifyOtp: (opts) => ipcRenderer.invoke("api:verifyOtp", opts),

	getProfile: () => ipcRenderer.invoke("api:getProfile"),
	updateProfile: (opts) => ipcRenderer.invoke("api:updateProfile", opts),

	updateShop: (opts) => ipcRenderer.invoke("api:updateShop", opts),



	// Jobs
	fetchJobs: () => ipcRenderer.invoke("jobs:fetch"),
	onJobsUpdate: (callback) => {
		const handler = (_event, jobs) => callback(jobs);
		ipcRenderer.on("jobs:updated", handler);
		return () => ipcRenderer.removeListener("jobs:updated", handler);
	},

	// Shop
	updateShop: (shopId, data) => ipcRenderer.invoke("shop:update", shopId, data),
});