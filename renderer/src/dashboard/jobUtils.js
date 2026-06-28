// ── Job status mapping helpers ────────────────────────────────────────────────
// "queued" = acknowledged by this app, waiting to be printed (still active).
export const ACTIVE_STATUSES = new Set(["draft", "submitted", "queued", "processing"]);

export function mapStatus(serverStatus) {
	if (serverStatus === "draft" || serverStatus === "submitted" || serverStatus === "queued") return "pending";
	if (serverStatus === "processing") return "processing";
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
function transformFile(file, index) {
	return {
		fileId: file.fileId || file.hash || `file-${index}`,
		name: file.name || file.fileName || `Document ${index + 1}`,
		settings: file.settings || {},
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
