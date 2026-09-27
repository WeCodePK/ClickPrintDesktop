import { useEffect, useState } from "react";
import {
	PdfGlyph,
	UserGlyph,
	PrinterIcon,
	EyeIcon,
	CheckIcon,
	AlertIcon,
	RetryIcon,
	CheckFilledIcon,
	AlertFilledIcon,
	WalletIcon,
} from "../icons";
import { useFiles } from "../FilesContext";
import { getJobTotalPages, getBlockedReason } from "../jobUtils";
import { getPdfThumb, forgetPdfThumb } from "../pdfThumbs";
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

function blockedTitle(reason) {
	switch (reason) {
		case "pdf-cancel":
			return "The PDF save dialog was cancelled — this document has not printed";
		case "route":
			return "No service printer matches this document's settings";
		default:
			return "This document failed to print";
	}
}

// First page of the cached PDF (see pdfThumbs). A document that fails to
// download or render — corrupt, truncated, not really a PDF — gets one big
// Reload button, which fetches a fresh copy and renders again.
function FileThumb({ file }) {
	const { fileStatus, fileUrl, redownloadFile } = useFiles();
	const status = fileStatus[file.fileId];
	// null while rendering | { url } | { failed: true } — tagged with its file so
	// a render finishing after the operator moved on is never shown.
	const [thumb, setThumb] = useState(null);
	const [reloading, setReloading] = useState(false);
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		setThumb(null);
		if (status !== "ready" || reloading) return;
		let active = true;
		getPdfThumb(file.fileId, fileUrl(file.fileId)).then(
			(url) => active && setThumb({ fileId: file.fileId, url }),
			(err) => {
				console.warn(`[Renderer] preview failed for ${file.fileId}:`, err?.message || err);
				if (active) setThumb({ fileId: file.fileId, failed: true });
			}
		);
		return () => {
			active = false;
		};
	}, [file.fileId, status, reloading, attempt, fileUrl]);

	const reload = async () => {
		setReloading(true);
		forgetPdfThumb(file.fileId);
		try {
			await redownloadFile(file.fileId);
		} catch (err) {
			console.error(`[Renderer] reload failed for ${file.fileId}:`, err);
		}
		forgetPdfThumb(file.fileId); // anything rendered from the old copy meanwhile
		setReloading(false);
		setAttempt((n) => n + 1);
	};

	const current = thumb?.fileId === file.fileId ? thumb : null;

	if (status === "downloading" || reloading) {
		return (
			<div className="file-preview__thumb">
				<div className="spinner spinner--dark" style={{ borderTopColor: "var(--color-primary)" }} />
				<span className="file-preview__thumb-label">Downloading…</span>
			</div>
		);
	}

	if (status === "error" || (status === "ready" && current?.failed)) {
		return (
			<button
				type="button"
				className="file-preview__thumb file-preview__reload"
				onClick={reload}
				title="This document couldn't be shown — download it again"
			>
				<RetryIcon />
				<span className="file-preview__reload-label">Reload</span>
			</button>
		);
	}

	if (status === "ready") {
		return (
			<div className="file-preview__thumb file-preview__thumb--pdf">
				{current?.url ? (
					<img className="file-preview__page" src={current.url} alt={`First page of ${file.name}`} />
				) : (
					<div className="spinner spinner--dark" style={{ borderTopColor: "var(--color-primary)" }} />
				)}
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

// Human hint for why a queued document hasn't started printing yet.
function waitHint(waitReason) {
	switch (waitReason) {
		case "downloading":
			return "Queued · downloading…";
		case "paused":
			return "Queued · automated printing paused";
		case "job-paused":
			return "Queued · automated printing paused for this job";
		case "job-sequence":
			// Print-all sends documents one at a time; this one is behind another.
			return "Queued · next in line";
		case "no-online-printer":
			return "Queued · printer offline";
		case "route":
			return "Queued · no matching service printer";
		default:
			return "Queued";
	}
}

function FilePreview({ file, index, onPreview, onPrint, showPreview, printed, onMarkJobFailed, printers, onPrinterMenuOpen, autoPrintOn, state }) {
	const settings = file.settings || {};
	// Per-file engine state: "waiting" | "printing" | "verifying" | "printed" | "failed".
	const printingNow = state?.status === "printing" || state?.status === "verifying";
	const queued = state?.status === "waiting";

	// A document is BLOCKED when it will not print without the operator doing
	// something (see getBlockedReason for the three causes). All three get the
	// same treatment: a warning glyph instead of the tick, the action button in
	// accent orange, and the job-level "mark failed" escape hatch. None of them
	// ever fails the job on its own. AutoPrintContext sounds the alert off the
	// same helper.
	const blockedReason = getBlockedReason(state, printed);
	const blocked = !!blockedReason;
	return (
		<div
			className={`file-preview ${printed ? "file-preview--printed" : ""} ${printingNow ? "file-preview--printing" : ""} ${
				blocked ? "file-preview--failed" : ""
			}`}
		>
			<div className="file-preview__heading">
				<span className="file-preview__index">{index + 1}</span>
				<span className="file-preview__name" title={file.name}>{file.name}</span>
				{printingNow ? (
					<span className="file-preview__badge file-preview__badge--printing">
						<div className="spinner spinner--dark" style={{ borderTopColor: "var(--color-primary)", width: "11px", height: "11px" }} />
						Printing…
					</span>
				) : queued ? (
					<span className="file-preview__badge file-preview__badge--printing" title={waitHint(state?.waitReason)}>
						{waitHint(state?.waitReason)}
					</span>
				) : null}
			</div>
			<div className="file-preview__content">
				{showPreview && <FileThumb file={file} />}
				<div className="file-preview__settings">
					<div className="file-preview__pages">
						<div className="file-preview__pages-text">
							<span className="file-preview__pages-label">No. of Pages</span>
							<span className="file-preview__pages-value">{file.numberOfPages ?? "—"}</span>
						</div>
						{/* Outcome mark for the document — the one place it's shown. */}
						{printed ? (
							<span className="file-preview__mark file-preview__mark--printed" title="This document printed successfully">
								<CheckFilledIcon />
							</span>
						) : blocked ? (
							<span className="file-preview__mark file-preview__mark--failed" title={blockedTitle(blockedReason)}>
								<AlertFilledIcon />
							</span>
						) : null}
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
						) : blocked ? (
							// Blocked for ANY reason — failed print, cancelled PDF save, or no
							// matching service printer. Accent orange, never the go-green, and
							// always with the dropdown so the operator can force a printer
							// (the only way out of a routing gap without editing Services).
							<PrintSplitButton
								size="sm"
								tone="retry"
								onPrint={(deviceName) => onPrint(file, deviceName)}
								onOpen={onPrinterMenuOpen}
								printers={printers}
								label={
									blockedReason === "route" ? (
										<>
											<PrinterIcon />
											Print
										</>
									) : (
										<>
											<RetryIcon />
											Retry
										</>
									)
								}
							/>
						) : queued ? (
							<button className="btn-gradient btn-sm" disabled>
								Queued
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
			{/* One box for every blocked cause. A blocked document never fails the
			    job on its own — this is the only place the whole job can be failed,
			    and only via its button. */}
			{blocked && (
				<div className="file-preview__failure">
					<span>
						{blockedReason === "pdf-cancel" ? (
							<>
								Saving document ({index + 1}) as a PDF was cancelled — nothing was printed
								and the job has not been changed. Press <strong>Retry</strong> to try again.
							</>
						) : blockedReason === "route" ? (
							<>
								No service printer matches document ({index + 1})'s settings, so it can't be
								printed automatically. Assign a printer to a matching service in the Services
								tab, or pick one now from the <strong>dropdown</strong> beside Print.
							</>
						) : (
							<>
								Document ({index + 1}) failed to print. The job is still open — press{" "}
								<strong>Retry</strong> to print it again.
							</>
						)}
					</span>
					<button type="button" className="file-preview__failure-btn" onClick={onMarkJobFailed}>
						<AlertIcon />
						Mark entire job as failed
					</button>
					<span className="file-preview__failure-note">
						NOTE: the customer is refunded when the job is marked as failed
					</span>
				</div>
			)}
		</div>
	);
}

// Full-size view of a payment proof, since the tile is too small to read a
// transaction id off. "Open in viewer" hands it to the OS image viewer, where it
// can be zoomed properly.
function ProofLightbox({ src, fileId, onClose, onImageError }) {
	const { openProof } = useFiles();

	useEffect(() => {
		const onKeyDown = (event) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	return (
		<div className="modal-overlay" onClick={onClose}>
			<div className="proof-lightbox" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
				<div className="proof-lightbox__head">
					<h3 className="proof-lightbox__title">Payment Proof</h3>
					<div className="proof-lightbox__actions">
						<button className="btn-outline btn-sm" onClick={() => openProof(fileId)}>
							<EyeIcon />
							Open in viewer
						</button>
						<button className="btn-outline btn-sm" onClick={onClose}>
							Close
						</button>
					</div>
				</div>
				<img className="proof-lightbox__img" src={src} alt="Payment proof" onError={onImageError} />
			</div>
		</div>
	);
}

// The customer's proof of payment (a transfer screenshot), downloaded in the
// background the moment its job lands — so the common case is simply the cached
// image, shown whole in its own tile. The other states cover a download still in
// flight, one that failed (retryable), a proof whose bytes aren't an image the
// preview can render, and a job whose cache has already been cleaned up on
// completion, where the proof is fetched on demand instead (History).
function PaymentProofTile({ fileId }) {
	const { fileStatus, proofUrl, ensureProof, openProof } = useFiles();
	const [zoomed, setZoomed] = useState(false);
	const [imageError, setImageError] = useState(false);
	// Bumped on every retry so the cached (possibly 404) response isn't reused.
	const [reloadKey, setReloadKey] = useState(0);

	const status = fileStatus[fileId];
	const showing = !!fileId && status === "ready" && !imageError;

	// Selecting a different job reuses this component — start its state clean.
	useEffect(() => {
		setZoomed(false);
		setImageError(false);
	}, [fileId]);

	const src = `${proofUrl(fileId)}${reloadKey ? `?r=${reloadKey}` : ""}`;

	const retry = () => {
		setImageError(false);
		setReloadKey((key) => key + 1);
		ensureProof(fileId);
	};

	return (
		<div className="detail-tile detail-tile--proof">
			<div className="detail-tile__header detail-tile__header--split">
				<h4 className="receipt-title payment-proof__title">
					<WalletIcon />
					Payment Proof
				</h4>
				{showing && (
					<button
						type="button"
						className="proof-eye-btn"
						onClick={() => setZoomed(true)}
						title="View payment proof full size"
						aria-label="View payment proof full size"
					>
						<EyeIcon />
					</button>
				)}
			</div>
			<div className="detail-tile__body payment-proof">
				{!fileId ? (
					<div className="payment-proof__placeholder">
						<span>No payment proof was attached to this job.</span>
					</div>
				) : showing ? (
					<>
						<button
							type="button"
							className="payment-proof__view"
							onClick={() => setZoomed(true)}
							title="Click to view full size"
						>
							<img
								className="payment-proof__img"
								src={src}
								alt="Payment proof"
								onError={() => setImageError(true)}
							/>
							<span className="payment-proof__zoom">
								<EyeIcon />
							</span>
						</button>
						{zoomed && (
							<ProofLightbox
								src={src}
								fileId={fileId}
								onClose={() => setZoomed(false)}
								onImageError={() => {
									setImageError(true);
									setZoomed(false);
								}}
							/>
						)}
					</>
				) : status === "downloading" ? (
					<div className="payment-proof__placeholder">
						<div className="spinner spinner--dark" style={{ borderTopColor: "var(--color-primary)" }} />
						<span>Downloading…</span>
					</div>
				) : status === "error" ? (
					<div className="payment-proof__placeholder">
						<span>Couldn't download the payment proof.</span>
						<button type="button" className="btn-outline btn-sm" onClick={retry}>
							<RetryIcon />
							Retry
						</button>
					</div>
				) : imageError ? (
					// Downloaded, but not something the preview can draw (e.g. a PDF
					// receipt instead of a screenshot) — or the cached copy has since been
					// cleaned up. Either way the OS viewer is the way through: openProof
					// re-downloads first if needed.
					<div className="payment-proof__placeholder">
						<span>This payment proof can't be previewed here.</span>
						<button type="button" className="btn-outline btn-sm" onClick={() => openProof(fileId)}>
							<EyeIcon />
							Open in viewer
						</button>
					</div>
				) : (
					// No download has been attempted in this session — the job's cache was
					// dropped when it reached a terminal state (History).
					<div className="payment-proof__placeholder">
						<button type="button" className="btn-outline btn-sm" onClick={retry}>
							<EyeIcon />
							Load payment proof
						</button>
					</div>
				)}
			</div>
		</div>
	);
}

// Free text the customer attached to the job (`additionalComments`).
function JobNoteRow({ label, text }) {
	return (
		<div className="receipt-row job-detail__note">
			<span className="receipt-label">{label}</span>
			<span className="receipt-value job-detail__note-text">"{text}"</span>
		</div>
	);
}

//  Detail card shared by the Print Jobs and History tabs:
//   ┌───────────────┬──────────────────┐
//   │ Job detail    │                  │
//   │ + cost        │   File previews  │
//   ├───────────────┤                  │
//   │ Payment proof │                  │
//   └───────────────┴──────────────────┘

function JobDetailCard({ entry, headerActions, onPreviewFile, onPrintFile, showPreview = true, printedFileIds, fileStates, onMarkJobFailed, printers, onPrinterMenuOpen, autoPrintOn }) {
	const files = entry.files || [];
	const cost = entry.cost;
	const totalPages = getJobTotalPages(entry);
	const costRows = [
		...(cost?.lines || []).map((line, i) => ({
			key: `line-${i}`,
			item: line.item,
			detail: `(${line.quantity} × Rs. ${line.rate})`,
			subtotal: line.subtotal,
		})),
		...(cost?.extra || []).map((line, i) => ({ key: `extra-${i}`, item: line.item, subtotal: line.subtotal })),
	];

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
						{/* this is not a utmost information, already printing mode is displayed in each job */}
						{/* <div className="receipt-row">
							<span className="receipt-label">Printing Mode</span>
							<span className="receipt-value">{getJobPrintMode(entry)}</span>
						</div> */}
						<div className="receipt-row">
							<span className="receipt-label">Total Pages</span>
							<span className="receipt-value">
								{totalPages != null ? `${totalPages} ${totalPages === 1 ? "page" : "pages"}` : "—"}
							</span>
						</div>
						{entry.additionalComments && (
							<JobNoteRow label="Additional Comments" text={entry.additionalComments} />
						)}

						{costRows.length > 0 && (
							<>
								<div className="receipt-divider" />
								{/* One line per document. A lone line carries the emphasis
								    itself; several read as plain rows, with the emphasised
								    total beside the heading. */}
								{costRows.length > 1 ? (
									<div className="receipt-row">
										<span className="detail-tile__subhead">Cost Breakdown</span>
										<span className="receipt-cost-value">
											Rs. {cost?.total ?? costRows.reduce((sum, row) => sum + (Number(row.subtotal) || 0), 0)}
										</span>
									</div>
								) : (
									<span className="detail-tile__subhead">Cost Breakdown</span>
								)}
								{costRows.map((row) => (
									<div key={row.key} className="receipt-row">
										<span className="receipt-label">
											{row.item}
											{row.detail && <span style={{ color: "var(--color-text-muted)" }}> {row.detail}</span>}
										</span>
										<span className={costRows.length > 1 ? "receipt-value" : "receipt-cost-value"}>
											Rs. {row.subtotal}
										</span>
									</div>
								))}
							</>
						)}
					</div>
				</div>

				{/* Bottom-left — payment proof. `paymentProofFileId` is optional, so the
				    tile also covers the job that came without one. */}
				<PaymentProofTile fileId={entry.paymentProofFileId} />

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
								onMarkJobFailed={onMarkJobFailed}
								printers={printers}
								onPrinterMenuOpen={onPrinterMenuOpen}
								autoPrintOn={autoPrintOn}
								state={fileStates?.[file.fileId]}
							/>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}

export default JobDetailCard;
