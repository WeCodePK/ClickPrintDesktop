import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { EyeIcon, ChevronDownIcon } from "../icons";
import { useFiles } from "../FilesContext";

// Opens a document in the OS default app. The main button opens the PDF — the
// version that gets printed. When the customer uploaded something else (a .docx,
// an image…) and that original is in the job's folder, a dropdown offers both:
// the PDF, or the original in its own app.
function OpenFileButton({ file, onOpen }) {
	const { fileStatus } = useFiles();
	const ready = fileStatus[file.fileId] === "ready";
	// { name, ext } of the original upload, or null when there's only the PDF.
	const [raw, setRaw] = useState(null);
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState(null);
	const rowRef = useRef(null);
	const menuRef = useRef(null);

	// The original is saved alongside the PDF, so it's known once the download is
	// ready. Tagged with its file so a late answer never lands on another card.
	useEffect(() => {
		setRaw(null);
		if (!ready) return;
		let active = true;
		window.electronAPI
			.getRawFileInfo(file.fileId)
			.then((info) => active && setRaw(info ? { ...info, fileId: file.fileId } : null))
			.catch(() => {});
		return () => {
			active = false;
		};
	}, [file.fileId, ready]);

	useEffect(() => {
		if (!open) return;
		const onDocDown = (e) => {
			if (menuRef.current?.contains(e.target) || rowRef.current?.contains(e.target)) return;
			setOpen(false);
		};
		const onKey = (e) => e.key === "Escape" && setOpen(false);
		const close = () => setOpen(false);
		document.addEventListener("mousedown", onDocDown);
		document.addEventListener("keydown", onKey);
		window.addEventListener("resize", close);
		window.addEventListener("scroll", close, true);
		return () => {
			document.removeEventListener("mousedown", onDocDown);
			document.removeEventListener("keydown", onKey);
			window.removeEventListener("resize", close);
			window.removeEventListener("scroll", close, true);
		};
	}, [open]);

	const original = raw?.fileId === file.fileId ? raw : null;

	if (!original) {
		return (
			<button className="btn-outline btn-sm" onClick={() => onOpen(file)} title="Open the PDF">
				<EyeIcon />
				Open
			</button>
		);
	}

	const openMenu = () => {
		const rect = rowRef.current?.getBoundingClientRect();
		if (rect) setPos({ top: rect.bottom + 6, left: rect.left });
		setOpen(true);
	};

	const pick = (opts) => {
		setOpen(false);
		onOpen(file, opts);
	};

	return (
		<div className="open-split" ref={rowRef}>
			<button className="btn-outline btn-sm open-split__main" onClick={() => onOpen(file)} title="Open the PDF">
				<EyeIcon />
				Open
			</button>
			<button
				type="button"
				className="btn-outline btn-sm open-split__toggle"
				onClick={() => (open ? setOpen(false) : openMenu())}
				aria-label="Choose which version to open"
				title="Open the PDF or the original file"
			>
				<ChevronDownIcon />
			</button>

			{open && pos && createPortal(
				<div
					ref={menuRef}
					className="print-split__menu"
					style={{ position: "fixed", top: pos.top, left: pos.left }}
				>
					<div className="print-split__menu-title">Open…</div>
					<button type="button" className="print-split__item" onClick={() => pick()}>
						<span className="print-split__item-name">PDF</span>
						<span className="open-split__item-hint">what gets printed</span>
					</button>
					<button type="button" className="print-split__item" onClick={() => pick({ raw: true })} title={original.name}>
						<span className="print-split__item-name">Original{original.ext ? ` (.${original.ext})` : ""}</span>
						<span className="open-split__item-hint">as uploaded</span>
					</button>
				</div>,
				document.body
			)}
		</div>
	);
}

export default OpenFileButton;
