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

// Total pages physically printed across a job's files (page count × copies).
// Returns null when no file reports a page count (older data) so callers can
// render a placeholder.
export function getJobTotalPages(entry) {
	const files = entry.files || [];
	let total = 0;
	let any = false;
	for (const file of files) {
		if (typeof file.numberOfPages === "number") {
			total += file.numberOfPages * (file.settings?.numberOfCopies || 1);
			any = true;
		}
	}
	return any ? total : null;
}

export function getJobPrintMode(entry, isShort = false) {
	const files = entry.files || [];
	if (files.length === 0) {
		if (isShort) {
			return entry.color ? "Color" : "B&W";
		}
		return entry.color ? "Coloured" : "Black & White";
	}

	let hasColor = false;
	let hasBW = false;
	for (const file of files) {
		if (file.settings?.color) {
			hasColor = true;
		} else {
			hasBW = true;
		}
	}

	if (hasColor && hasBW) {
		return isShort ? "Mixed" : "Mixed (Coloured & B/W)";
	}
	if (hasColor) {
		return isShort ? "Color" : "Coloured";
	}
	return isShort ? "B&W" : "Black & White";
}

