const path = require("path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { registerIpcHandlers } = require("./ipc-handlers");

let mainWindow = null;
const isDev = !app.isPackaged;

function createWindow() {
	mainWindow = new BrowserWindow({
		show: false,
		minWidth: 900,
		minHeight: 600,
		frame: false,
		titleBarStyle: "hidden",
		backgroundColor: "#F7F8FA",
		icon: path.join(__dirname, "assets", "icon.png"),
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			nodeIntegration: false,
			contextIsolation: true,
		},
	});

	// Show maximized once the page is ready to avoid the window flashing small first
	mainWindow.once("ready-to-show", () => {
		mainWindow.maximize();
		mainWindow.show();
	});

	if (isDev) {
		mainWindow.loadURL("http://localhost:3001");
	} else {
		mainWindow.loadFile(path.join(__dirname, "../renderer/dist/index.html"));
	}

	mainWindow.on("closed", () => {
		mainWindow = null;
	});
}

registerIpcHandlers(() => mainWindow);

ipcMain.on("window:minimize", () => {
	mainWindow?.minimize();
});

ipcMain.on("window:maximize", () => {
	if (mainWindow?.isMaximized()) {
		mainWindow.unmaximize();
	} else {
		mainWindow?.maximize();
	}
});

ipcMain.on("window:close", () => {
	mainWindow?.close();
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

app.on("activate", () => {
	if (BrowserWindow.getAllWindows().length === 0) {
		createWindow();
	}
});
