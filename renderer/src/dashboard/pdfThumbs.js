// First-page thumbnails of cached job PDFs, rendered with pdf.js and kept in
// memory for the session. The preview used to embed Chromium's PDF viewer in an
// <iframe>, which booted from scratch every time a job was opened (a second or
// two, even though the file itself is cached on disk) and trapped any render
// error inside the frame where the app couldn't see it. Here a revisit is
// instant and every failure reaches the UI.

const THUMB_WIDTH = 150; // CSS width of .file-preview__thumb
const MAX_CACHED = 60;

// fileId -> Promise<data URL of the rendered PNG>. Map order is recency (a hit
// re-inserts its entry), so the first key is the one to evict.
const cache = new Map();

let pdfjsPromise = null;

// pdf.js is large, so it loads on first use. It runs on this thread: exposing the
// worker module as globalThis.pdfjsWorker makes pdf.js use it in-page instead of
// spawning a Worker, which in production would have to load from the app's
// file:// origin. One small page per thumbnail is cheap enough for that.
function loadPdfjs() {
	if (!pdfjsPromise) {
		pdfjsPromise = (async () => {
			globalThis.pdfjsWorker = await import("pdfjs-dist/build/pdf.worker.mjs");
			return import("pdfjs-dist");
		})();
		pdfjsPromise.catch(() => {
			pdfjsPromise = null;
		});
	}
	return pdfjsPromise;
}

async function renderFirstPage(url) {
	const pdfjs = await loadPdfjs();
	const response = await fetch(url);
	if (!response.ok) throw new Error(`file unavailable (${response.status})`);
	const data = new Uint8Array(await response.arrayBuffer());

	const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
	try {
		const page = await doc.getPage(1);
		const density = Math.max(2, window.devicePixelRatio || 1);
		const viewport = page.getViewport({ scale: (THUMB_WIDTH * density) / page.getViewport({ scale: 1 }).width });
		const canvas = document.createElement("canvas");
		canvas.width = Math.ceil(viewport.width);
		canvas.height = Math.ceil(viewport.height);
		// "print" intent: the page as it will print (print-only annotations and
		// layers), and pdf.js schedules it without requestAnimationFrame — which
		// stalls while the window is hidden, e.g. minimised to the tray.
		await page.render({ canvasContext: canvas.getContext("2d"), viewport, intent: "print" }).promise;
		// toDataURL, not toBlob: Chromium encodes toBlob in idle time and, with no
		// idle time to spare, holds it for up to a second — the very lag this
		// module exists to remove. A thumbnail encodes synchronously in a few ms.
		return canvas.toDataURL("image/png");
	} finally {
		doc.destroy();
	}
}

// Resolves to an image URL for the file's first page; rejects if the PDF can't be
// read or rendered. Concurrent requests for one file share a single render.
export function getPdfThumb(fileId, url) {
	const cached = cache.get(fileId);
	if (cached) {
		cache.delete(fileId);
		cache.set(fileId, cached);
		return cached;
	}

	const entry = renderFirstPage(url);
	cache.set(fileId, entry);
	// Failures aren't kept, so the next attempt (Reload) renders afresh.
	entry.catch(() => {
		if (cache.get(fileId) === entry) cache.delete(fileId);
	});
	while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
	return entry;
}

// Drops a file's thumbnail, e.g. before its cached copy is replaced.
export function forgetPdfThumb(fileId) {
	cache.delete(fileId);
}
