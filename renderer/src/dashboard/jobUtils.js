// ── Job status mapping helpers ────────────────────────────────────────────────
// "queued" = acknowledged by this app, waiting to be printed (still active).
export const ACTIVE_STATUSES = new Set(["draft", "submitted", "queued", "processing", "printing"]);

export function mapStatus(serverStatus) {
	if (serverStatus === "draft" || serverStatus === "submitted" || serverStatus === "queued") return "pending";
	if (serverStatus === "processing" || serverStatus === "printing") return "processing";
	return "completed";
}

export function formatTime(isoString) {
	return new Date(isoString).toLocaleTimeString("en-US", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: true,
	});
}

// Normalise a single file entry so the UI always has a display name + settings.
// The backend nests the document under `file` ({ _id, originalName, numberOfPages })
// with print settings alongside it; older fallbacks are kept for safety.
function transformFile(entry, index) {
	const doc = entry.file || {};
	return {
		fileId: doc._id || entry.fileId || entry.hash || `file-${index}`,
		name: doc.originalName || entry.name || entry.fileName || `Document ${index + 1}`,
		numberOfPages: doc.numberOfPages ?? entry.numberOfPages,
		settings: entry.settings || {},
	};
}

export function transformJob(job) {
	const files = (job.files || []).map(transformFile);
	const totalCopies = files.reduce((sum, f) => sum + (f.settings.numberOfCopies || 1), 0);
	const anyColor = files.some((f) => f.settings.color);

	return {
		_id: job._id,
		// Summary fields consumed by the list rows.
		fileName: files.length > 1 ? `${files.length} documents` : files[0]?.name || "Document",
		copies: totalCopies || 1,
		color: anyColor,
		status: mapStatus(job.status),
		rawStatus: job.status,
		createdAt: job.createdAt,
		time: formatTime(job.createdAt),
		filesCount: files.length || 1,
		price: job.cost?.total ?? job.price ?? (totalCopies || 1) * (anyColor ? 30 : 10),
		note: job.note || "",
		// Full detail consumed by JobDetailCard.
		files,
		cost: job.cost || null,
		// The jobs endpoint populates createdBy as { name, number }; the history
		// endpoint returns just an id string, which we can't display.
		createdBy: job.createdBy && typeof job.createdBy === "object" ? job.createdBy : null,
		statusHistory: job.statusHistory || [],
	};
}
