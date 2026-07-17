import { PdfGlyph, UserGlyph, PrinterIcon, EyeIcon, CheckIcon } from "../icons";
import { useFiles } from "../FilesContext";
import { getJobPrintMode, getJobTotalPages } from "../jobUtils";
import PrintSplitButton from "./PrintSplitButton";

function sidednessLabel(value) {
	switch (value) {
		case "none":
			return "Single-sided";
		case "long":
			return "Double-sided (long edge)";
		case "short":
			return "Double-sided (short edge)";
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
	].filter((row) => row.value != null && row.value !== "");
}

function fileMinorFields(settings = {}) {
	return [
		{ label: "Copies", value: `${settings.numberOfCopies || 1}×` },
		{ label: "Pages/Sheet", value: settings.pagesPerSheet || 1 },
		{ label: "Range", value: settings.pageSelection || "All pages" },
	];
}

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

function FilePreview({ file, index, onPreview, onPrint, showPreview, printed, failed, onMarkJobFailed, printingAll, printers, selectedPrinterName, onPrinterMenuOpen, autoPrintOn, printingNow }) {
	const settings = file.settings || {};
	return (
		<div className={`file-preview ${printed ? "file-preview--printed" : ""} ${printingNow ? "file-preview--printing" : ""}`}>
			<div className="file-preview__heading">
				<span className="file-preview__index">{index + 1}</span>
				<span className="file-preview__name" title={file.name}>{file.name}</span>
				{printed ? (
					<span className="file-preview__badge">
						<CheckIcon />
						Printed
					</span>
				) : printingNow ? (
					<span className="file-preview__badge file-preview__badge--printing">
						<div className="spinner spinner--dark" style={{ borderTopColor: "var(--color-primary)", width: "11px", height: "11px" }} />
						Printing…
					</span>
				) : null}
			</div>
			<div className="file-preview__content">
				{showPreview && <FileThumb file={file} />}
				<div className="file-preview__settings">
					<div className="file-preview__pages">
						<span className="file-preview__pages-label">No. of Pages</span>
						<span className="file-preview__pages-value">{file.numberOfPages ?? "—"}</span>
					</div>
					{fileSettingRows(settings).map((row) => (
						<div key={row.label} className="receipt-row">
							<span className="receipt-label">{row.label}</span>
							<span className="receipt-value" style={row.capitalize ? { textTransform: "capitalize" } : undefined}>
								{row.value}
							</span>
						</div>
					))}
					<div className="file-preview__minor">
						{fileMinorFields(settings).map((f, i) => (
							<span key={f.label} className="file-preview__minor-item">
								{i > 0 && <span className="file-preview__minor-sep">|</span>}
								{f.label}: {f.value}
							</span>
						))}
					</div>
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
						printed ? (
							<button className="btn-gradient btn-sm" disabled>
								<CheckIcon />
								Printed
							</button>
						) : printingNow ? (
							<button className="btn-gradient btn-sm" disabled>
								<div className="spinner spinner--dark" style={{ borderTopColor: "#111b21", width: "14px", height: "14px" }} />
								Printing…
							</button>
						) : autoPrintOn ? (
							<span className="autoprint-tip" title="Automated printing is on — printing is handled automatically">
								<button className="btn-gradient btn-sm" disabled style={{ pointerEvents: "none", width: "100%" }}>
									<PrinterIcon />
									Print
								</button>
							</span>
						) : (
							<PrintSplitButton
								size="sm"
								onPrint={(deviceName) => onPrint(file, deviceName)}
								onOpen={onPrinterMenuOpen}
								printers={printers}
								selectedName={selectedPrinterName}
								disabled={printingAll}
								label={
									<>
										<PrinterIcon />
										Print
									</>
								}
							/>
						)
					)}
				</div>
			)}
			{failed && !printed && !printingNow && (
				<div className="file-preview__failure">
					<span>
						Failure in printing doc ({index + 1}). Retry or to mark the job as failed,{" "}
						<button type="button" className="file-preview__failure-link" onClick={onMarkJobFailed}>
							click here…
						</button>
					</span>
					<span className="file-preview__failure-note">
						NOTE: customer will be refunded in case of marked as failed
					</span>
				</div>
			)}
		</div>
	);
}

//  Detail card shared by the Print Jobs and History tabs:
//   ┌────────────┬──────────────────┐
//   │ Job detail │                  │
//   ├────────────┤   File previews  │
//   │    Cost    │                  │
//   └────────────┴──────────────────┘

function JobDetailCard({ entry, headerActions, onPreviewFile, onPrintFile, showPreview = true, printedFileIds, failedFileIds, onMarkJobFailed, printingAll, printers, selectedPrinterName, onPrinterMenuOpen, autoPrintOn, currentFileId }) {
	const files = entry.files || [];
	const cost = entry.cost;
	const totalPages = getJobTotalPages(entry);

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
						<span className="receipt-subtitle">Received {entry.time}</span>
						{entry.createdBy && (
							<span className="receipt-requester">
								<UserGlyph />
								{entry.createdBy.name}
								{entry.formattedNumber ? ` · ${entry.formattedNumber}` : ""}
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
							<span className="receipt-label">Printing Mode</span>
							<span className="receipt-value">{getJobPrintMode(entry)}</span>
						</div>
						<div className="receipt-row">
							<span className="receipt-label">Total Pages</span>
							<span className="receipt-value" style={{ color: "var(--color-accent)", fontWeight: 700 }}>
								{totalPages != null ? `${totalPages} ${totalPages === 1 ? "page" : "pages"}` : "—"}
							</span>
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
					<div className="detail-tile__body--scroll file-preview-list">
						{files.map((file, index) => (
							<FilePreview
								key={file.fileId || index}
								file={file}
								index={index}
								onPreview={onPreviewFile}
								onPrint={onPrintFile}
								showPreview={showPreview}
								printed={!!printedFileIds?.[file.fileId]}
								failed={!!failedFileIds?.[file.fileId]}
								onMarkJobFailed={onMarkJobFailed}
								printingAll={printingAll}
								printers={printers}
								selectedPrinterName={selectedPrinterName}
								onPrinterMenuOpen={onPrinterMenuOpen}
								autoPrintOn={autoPrintOn}
								printingNow={currentFileId === file.fileId}
							/>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}

export default JobDetailCard;
