import { PdfGlyph, UserGlyph, PrinterIcon, EyeIcon } from "../icons";
import { useFiles } from "../FilesContext";

function sidednessLabel(value) {
	switch (value) {
		case "single":
			return "Single-sided";
		case "long":
			return "Double-sided (long edge)";
		case "short":
			return "Double-sided (short edge)";
		case "double":
			return "Double-sided";
		default:
			return value || "—";
	}
}

function fileSettingRows(settings = {}) {
	return [
		{ label: "Print Mode", value: settings.color ? "Color" : "Black & White" },
		{ label: "Paper Size", value: settings.pageType || "—" },
		{ label: "Orientation", value: settings.orientation, capitalize: true },
		{ label: "Sides", value: sidednessLabel(settings.sidedness) },
		{ label: "Pages / Sheet", value: settings.pagesPerSheet || 1 },
		{ label: "Page Range", value: settings.pageSelection || "All pages" },
		{ label: "Copies", value: `${settings.numberOfCopies || 1}×` },
	].filter((row) => row.value != null && row.value !== "");
}

// ── File preview ──────────────────────────────────────────────────────────────
// Previews are placeholders for now — every uploaded file is treated as a PDF.

function FileThumb({ file }) {
	const { fileStatus, fileUrl } = useFiles();
	const status = fileStatus[file.fileId];

	if (status === "ready") {
		return (
			<div className="file-preview__thumb file-preview__thumb--pdf">
				<iframe
					className="file-preview__pdf"
					src={`${fileUrl(file.fileId)}#toolbar=0&navpanes=0&view=FitH`}
					title={file.name}
				/>
			</div>
		);
	}

	if (status === "downloading") {
		return (
			<div className="file-preview__thumb">
				<div className="spinner spinner--dark" style={{ borderTopColor: "var(--color-primary)" }} />
				<span className="file-preview__thumb-label">Downloading…</span>
			</div>
		);
	}

	return (
		<div className="file-preview__thumb">
			<PdfGlyph />
			<span className="file-preview__thumb-label">
				{status === "error" ? "Download failed" : "Preview unavailable"}
			</span>
		</div>
	);
}

function FilePreview({ file, index, onPreview, onPrint, showPreview }) {
	const settings = file.settings || {};
	return (
		<div className="file-preview">
			<div className="file-preview__heading">
				<span className="file-preview__index">{index + 1}</span>
				<span className="file-preview__name" title={file.name}>{file.name}</span>
			</div>
			<div className="file-preview__content">
				{showPreview && <FileThumb file={file} />}
				<div className="file-preview__settings">
					{fileSettingRows(settings).map((row) => (
						<div key={row.label} className="receipt-row">
							<span className="receipt-label">{row.label}</span>
							<span className="receipt-value" style={row.capitalize ? { textTransform: "capitalize" } : undefined}>
								{row.value}
							</span>
						</div>
					))}
				</div>
			</div>
			{(onPreview || onPrint) && (
				<div className="file-preview__actions">
					{onPreview && (
						<button className="btn-outline btn-sm" onClick={() => onPreview(file)}>
							<EyeIcon />
							Preview
						</button>
					)}
					{onPrint && (
						<button className="btn-gradient btn-sm" onClick={() => onPrint(file)}>
							<PrinterIcon />
							Print
						</button>
					)}
				</div>
			)}
		</div>
	);
}

// ── Detail card ───────────────────────────────────────────────────────────────
// Full-height quadrant layout shared by the Print Jobs and History tabs:
//   ┌────────────┬──────────────────┐
//   │ Job detail │                  │
//   ├────────────┤   File previews  │  (right column spans both rows, scrolls)
//   │    Cost    │                  │
//   └────────────┴──────────────────┘
// `headerActions` is an optional node (decline / mark-complete buttons) rendered
// beside the title. Per-file preview/print handlers, when provided, render
// action buttons under each file.
function JobDetailCard({ entry, headerActions, onPreviewFile, onPrintFile, showPreview = true }) {
	const files = entry.files || [];
	const cost = entry.cost;

	return (
		<div className="job-detail">
			<div className="job-detail__titlebar">
				<h3 className="db-detail__title">Document Details</h3>
				{headerActions && <div className="job-detail__header-actions">{headerActions}</div>}
			</div>

			<div className="detail-quad">
				{/* Top-left — job overview */}
				<div className="detail-tile detail-tile--info">
					<div className="detail-tile__header">
						<h4 className="receipt-title">{entry.fileName}</h4>
						<span className="receipt-subtitle">
							Job ID: #{entry._id.slice(-6)} · Received {entry.time}
						</span>
						{entry.createdBy && (
							<span className="receipt-requester">
								<UserGlyph />
								{entry.createdBy.name}
								{entry.createdBy.number ? ` · ${entry.createdBy.number}` : ""}
							</span>
						)}
					</div>
					<div className="detail-tile__body">
						<div className="receipt-row">
							<span className="receipt-label">Job Status</span>
							<span className={`db-status db-status--${entry.status}`}>
								{entry.rawStatus || entry.status}
							</span>
						</div>
						<div className="receipt-row">
							<span className="receipt-label">Total Files</span>
							<span className="receipt-value">{entry.filesCount} {entry.filesCount === 1 ? "document" : "documents"}</span>
						</div>
						<div className="receipt-row">
							<span className="receipt-label">Total Copies</span>
							<span className="receipt-value">{entry.copies}×</span>
						</div>
						<div className="receipt-row">
							<span className="receipt-label">Printing Mode</span>
							<span className="receipt-value">{entry.color ? "Color Print" : "Black & White"}</span>
						</div>
						{entry.note && (
							<div className="receipt-row" style={{ alignItems: "flex-start", marginTop: "4px" }}>
								<span className="receipt-label">User Note</span>
								<span className="receipt-value" style={{ maxWidth: "200px", fontSize: "12px", color: "var(--color-text-secondary)", textAlign: "right", fontStyle: "italic" }}>
									"{entry.note}"
								</span>
							</div>
						)}
					</div>
				</div>

				{/* Bottom-left — cost breakdown */}
				<div className="detail-tile detail-tile--cost">
					<div className="detail-tile__header">
						<h4 className="receipt-title">Cost Breakdown</h4>
					</div>
					<div className="detail-tile__body detail-tile__body--scroll">
						{cost ? (
							<>
								{(cost.lines || []).map((line, i) => {
									const [code, qty, unit, amount] = line;
									return (
										<div key={`line-${i}`} className="receipt-row">
											<span className="receipt-label">
												{code} <span style={{ color: "var(--color-text-muted)" }}>({qty} × Rs. {unit})</span>
											</span>
											<span className="receipt-value">Rs. {amount}</span>
										</div>
									);
								})}
								{(cost.extra || []).map((line, i) => {
									const [label, amount] = line;
									return (
										<div key={`extra-${i}`} className="receipt-row">
											<span className="receipt-label">{label}</span>
											<span className="receipt-value">Rs. {amount}</span>
										</div>
									);
								})}
								<div className="receipt-divider" />
							</>
						) : null}
						<div className="receipt-row">
							<span className="receipt-total-label">Print Charge</span>
							<span className="receipt-total-value">Rs. {cost?.total ?? entry.price}</span>
						</div>
					</div>
				</div>

				{/* Right — file previews (spans both rows, scrolls) */}
				<div className="detail-tile detail-tile--files">
					<div className="detail-tile__header">
						<h4 className="receipt-title">Files ({files.length})</h4>
					</div>
					<div className="detail-tile__body--scroll file-preview-list">
						{files.map((file, index) => (
							<FilePreview
								key={file.fileId || index}
								file={file}
								index={index}
								onPreview={onPreviewFile}
								onPrint={onPrintFile}
								showPreview={showPreview}
							/>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}

export default JobDetailCard;
