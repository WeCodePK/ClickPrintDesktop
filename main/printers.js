const { BrowserWindow } = require("electron");
const { execFile } = require("child_process");

// Win32 PRINTER_STATUS_OFFLINE flag — set when the printer is unreachable.
const PRINTER_STATUS_OFFLINE = 0x80;

// ── Offline detection (cached) ──────────────────────────────────────────────
// Chromium's getPrintersAsync `status` is unreliable for offline detection on
// Windows (it usually reports 0), so we ask WMI for each printer's WorkOffline
// flag — the same state Windows Settings shows. WMI is queried via a PowerShell
// child process, whose ~0.5s startup we keep off the UI path by caching the
// result and refreshing it in the background (stale-while-revalidate).

const OFFLINE_TTL = 25000; // cache is considered stale after this
const OFFLINE_MIN_GAP = 3000; // minimum gap between actual spawns (throttle)

let _offlineMap = {}; // name -> isOffline
let _offlineAt = 0; // last successful fetch (0 = never)
let _offlineInflight = null; // de-dupes concurrent refreshes

// Runs the actual WMI query in a child PowerShell. Resolves to a name → offline
// map, or null on failure / non-Windows so the caller keeps the last good map.
function _queryOfflineMap() {
	if (process.platform !== "win32") return Promise.resolve(null);
	return new Promise((resolve) => {
		execFile(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"Get-CimInstance Win32_Printer | Select-Object Name,WorkOffline | ConvertTo-Json -Compress",
			],
			{ windowsHide: true, timeout: 6000 },
			(error, stdout) => {
				if (error) {
					console.error("[Printers] offline query failed:", error.message);
					resolve(null);
					return;
				}
				try {
					let rows = JSON.parse(stdout || "[]");
					if (!Array.isArray(rows)) rows = [rows];
					const map = {};
					for (const row of rows) {
						if (row && row.Name) map[row.Name] = !!row.WorkOffline;
					}
					resolve(map);
				} catch (parseError) {
					console.error("[Printers] offline parse failed:", parseError.message);
					resolve(null);
				}
			}
		);
	});
}

// Refreshes the cached offline map. Coalesces concurrent calls and throttles
// spawns: `force` bypasses the TTL freshness check but still respects the
// minimum gap so rapid Refresh clicks can't spawn a PowerShell storm. A failed
// query leaves the previous good map in place.
function refreshOfflineCache(force = false) {
	if (_offlineInflight) return _offlineInflight;
	if (_offlineAt !== 0) {
		const age = Date.now() - _offlineAt;
		if (age < OFFLINE_MIN_GAP) return Promise.resolve(_offlineMap);
		if (!force && age < OFFLINE_TTL) return Promise.resolve(_offlineMap);
	}
	_offlineInflight = _queryOfflineMap()
		.then((map) => {
			if (map) {
				_offlineMap = map;
				_offlineAt = Date.now();
			}
			return _offlineMap;
		})
		.finally(() => {
			_offlineInflight = null;
		});
	return _offlineInflight;
}

// Warms the cache and starts a periodic background refresh. Call once on startup.
function startOfflineWatcher() {
	refreshOfflineCache(true);
	const timer = setInterval(() => refreshOfflineCache(), OFFLINE_TTL);
	if (timer.unref) timer.unref(); // don't hold the process open for this
}

function _isOffline(printer) {
	return (
		_offlineMap[printer.name] === true ||
		_offlineMap[printer.displayName] === true ||
		((printer.status || 0) & PRINTER_STATUS_OFFLINE) !== 0 // status-bit fallback
	);
}

// Lists every currently-ONLINE printer installed on this machine, virtual ones
// (XPS / OneNote / Fax / Print to PDF …) included — the operator decides which to
// register for the shop. Offline printers are excluded so callers can treat this
// as "what's reachable right now". The printer enumeration is always live; the
// offline map is served from cache (refreshed in the background), except on the
// cold first call or an explicit `force`, which wait for fresh data. Requires a
// live webContents to query.
async function listPrinters(win, force = false) {
	if (!win || win.isDestroyed()) return [];
	const printers = await win.webContents.getPrintersAsync();

	if (force || _offlineAt === 0) {
		await refreshOfflineCache(force); // wait for authoritative data
	} else if (Date.now() - _offlineAt > OFFLINE_TTL) {
		refreshOfflineCache(); // stale: revalidate in the background, use current map
	}

	return printers
		.filter((p) => !_isOffline(p))
		.map((p) => ({
			name: p.name,
			displayName: p.displayName || p.name,
			description: p.description || "",
			status: p.status, // 0 = idle/ready on Windows
			isDefault: !!p.isDefault,
		}));
}

const TEST_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{font-family:Arial,Helvetica,sans-serif;margin:60px;color:#111}
  h1{font-size:26px;margin:0 0 6px}
  .sub{color:#555;margin-bottom:26px;font-size:14px}
  .bars{display:flex;gap:6px;margin:22px 0}
  .bars span{display:block;width:34px;height:56px;border-radius:4px}
  table{border-collapse:collapse;margin-top:16px}
  td,th{border:1px solid #333;padding:8px 14px;font-size:13px;text-align:left}
  .foot{margin-top:32px;font-size:12px;color:#888}
</style></head><body>
  <h1>ClickPrint &mdash; Printer Test Page</h1>
  <div class="sub">If you can read this clearly, your printer is configured correctly.</div>
  <div class="bars">
    <span style="background:#00bcd4"></span><span style="background:#e91e63"></span>
    <span style="background:#ffc107"></span><span style="background:#4caf50"></span>
    <span style="background:#111"></span>
  </div>
  <table>
    <tr><th>Check</th><th>Expected</th></tr>
    <tr><td>Text rendering</td><td>Crisp, no smudging</td></tr>
    <tr><td>Color bars</td><td>Cyan / Magenta / Yellow / Green / Black</td></tr>
    <tr><td>Alignment</td><td>Even margins on all sides</td></tr>
  </table>
  <div class="foot">Printed __WHEN__ on __DEVICE__</div>
</body></html>`;

// Prints a self-contained test page to the given printer (silently, directly).
// Resolves once spooled; a flaky/missing completion callback is assumed-spooled
// after a grace period so the renderer never hangs.
async function printTestPage(deviceName) {
	const win = new BrowserWindow({ show: false });
	try {
		const html = TEST_HTML
			.replace("__WHEN__", new Date().toLocaleString())
			.replace("__DEVICE__", deviceName || "the default printer");
		await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
		await new Promise((r) => setTimeout(r, 200));

		await new Promise((resolve, reject) => {
			let settled = false;
			const finish = (fn, arg) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				fn(arg);
			};

			const options = { silent: true, printBackground: true };
			if (deviceName) options.deviceName = deviceName;

			win.webContents.print(options, (success, failureReason) => {
				console.log(`[Printers] test print callback: success=${success} reason=${failureReason}`);
				if (success) finish(resolve);
				else finish(reject, new Error(failureReason || "print failed"));
			});

			const timer = setTimeout(() => {
				console.log("[Printers] test print callback timed out, assuming spooled");
				finish(resolve);
			}, 8000);
		});
	} finally {
		if (!win.isDestroyed()) win.destroy();
	}
}

module.exports = { listPrinters, printTestPage, startOfflineWatcher };
