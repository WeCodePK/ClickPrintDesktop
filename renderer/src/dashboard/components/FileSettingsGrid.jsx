import { useEffect, useState } from "react";

// A document's print settings in two columns — Size, Color, Pages, Sides on the
// left; Orientation, Copies, Pages/Sheet, Duplex on the right — each a
// "label  value" row. When `editable`, every value is an inline control the operator can change
// before the document prints; the change goes to the print engine as a partial
// override (`onChange(patch)`). Values the operator changed are highlighted, and
// their tooltip shows what the customer originally chose.

// The backend's single `sidedness` value ("none" | "long" | "short") is shown as
// two settings: Sides (Single / Double) and, for double-sided, Duplex (which
// edge the page flips on). Both edit that one value. Sides sends `{ sides }` and
// the engine works out the flip edge (the customer's, or from the orientation —
// see main/fileSettings.applySettingsPatch); Duplex sets the edge explicitly.
const isDouble = (s) => !!s.sidedness && s.sidedness !== "none";
const DUPLEX_OPTIONS = [
	{ value: "long", label: "Flip on long edge" },
	{ value: "short", label: "Flip on short edge" },
];

// Paper sizes a service can be set up for (see ServiceForm) — anything else the
// customer chose stays selectable so it's never silently lost.
const PAGE_SIZES = ["A4", "A3"];

const COLUMNS = [
	[
		{
			key: "pageType",
			label: "Size",
			display: (s) => s.pageType || "—",
			editor: { type: "select", options: (s) => [...new Set([...PAGE_SIZES, s.pageType].filter(Boolean))].map((v) => ({ value: v, label: v })) },
		},
		{
			key: "color",
			label: "Color",
			display: (s) => (s.color ? "Color" : "Black & White"),
			editor: {
				type: "select",
				options: () => [
					{ value: true, label: "Color" },
					{ value: false, label: "Black & White" },
				],
			},
		},
		{
			key: "pageSelection",
			label: "Pages",
			display: (s) => s.pageSelection || "All pages",
			editor: { type: "text", placeholder: "All pages", hint: 'All pages, or e.g. "1-3, 5"' },
		},
		{
			key: "sidedness",
			label: "Sides",
			display: (s) => (isDouble(s) ? "Double" : "Single"),
			value: (s) => (isDouble(s) ? "double" : "single"),
			toPatch: (v) => ({ sides: v }),
			isChanged: (s, original) => isDouble(s) !== isDouble(original),
			editor: {
				type: "select",
				options: () => [
					{ value: "single", label: "Single" },
					{ value: "double", label: "Double" },
				],
			},
		},
	],
	[
		{
			key: "orientation",
			label: "Orientation",
			display: (s) => s.orientation || "—",
			capitalize: true,
			editor: {
				type: "select",
				options: () => [
					{ value: "portrait", label: "Portrait" },
					{ value: "landscape", label: "Landscape" },
				],
			},
		},
		{
			key: "numberOfCopies",
			label: "Copies",
			display: (s) => `${s.numberOfCopies || 1}×`,
			value: (s) => s.numberOfCopies || 1,
			editor: { type: "number", min: 1, max: 999 },
		},
		{
			key: "pagesPerSheet",
			label: "Pages/Sheet",
			display: (s) => s.pagesPerSheet || 1,
			value: (s) => s.pagesPerSheet || 1,
			editor: { type: "select", options: () => [1, 2, 4, 6, 9, 16].map((n) => ({ value: n, label: String(n) })) },
		},
		{
			id: "duplex",
			key: "sidedness",
			label: "Duplex",
			display: (s) => (isDouble(s) ? DUPLEX_OPTIONS.find((o) => o.value === s.sidedness)?.label || s.sidedness : "—"),
			value: (s) => (isDouble(s) ? s.sidedness : null),
			// Only meaningful for double-sided printing.
			disabled: (s) => !isDouble(s),
			// Changed when the operator picked the edge, or it differs from the
			// customer's — not when it was merely worked out from the orientation.
			isChanged: (s, original, keys) =>
				keys.includes("duplexExplicit") || (isDouble(s) && isDouble(original) && s.sidedness !== original.sidedness),
			editor: { type: "select", options: () => DUPLEX_OPTIONS },
		},
	],
];

const fieldValue = (field, settings) => (field.value ? field.value(settings) : settings[field.key]);

// Select for a fixed set of values. <option> values are strings, so the chosen
// one is mapped back to its typed value (true/false, numbers).
function SelectControl({ field, settings, onCommit, title }) {
	const current = fieldValue(field, settings);
	const options = field.editor.options(settings);
	const known = options.some((o) => o.value === current);
	const disabled = !!field.disabled?.(settings);
	return (
		<select
			className="file-preview__spec-input"
			value={known ? String(current) : ""}
			disabled={disabled}
			onChange={(e) => {
				const picked = options.find((o) => String(o.value) === e.target.value);
				if (picked) onCommit(picked.value);
			}}
			title={disabled ? "Only for double-sided printing" : title || "Click to change"}
		>
			{!known && (
				<option value="" disabled>
					{field.display(settings)}
				</option>
			)}
			{options.map((o) => (
				<option key={String(o.value)} value={String(o.value)}>
					{o.label}
				</option>
			))}
		</select>
	);
}

// Free-form value (page range, copies): edited as a draft, committed on Enter or
// when focus leaves, reverted with Esc. `size` grows with the text so the field
// is always at least as wide as what's in it — nothing is clipped. Copies is a
// text field with a numeric keypad rather than type="number", which can't be
// sized to its content (the engine rejects anything that isn't a whole number).
function InputControl({ field, settings, onCommit, title }) {
	const current = fieldValue(field, settings);
	const initial = current == null ? "" : String(current);
	const [draft, setDraft] = useState(initial);
	useEffect(() => setDraft(initial), [initial]);

	const commit = () => {
		const next = draft.trim();
		if (next === initial) return;
		if (field.editor.type === "number") onCommit(next === "" ? 1 : Number(next));
		else onCommit(next);
	};

	return (
		<input
			className="file-preview__spec-input"
			type="text"
			inputMode={field.editor.type === "number" ? "numeric" : undefined}
			size={Math.max((draft || field.editor.placeholder || "").length + 1, field.editor.type === "number" ? 3 : 6)}
			value={draft}
			placeholder={field.editor.placeholder}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={commit}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
				if (e.key === "Escape") {
					setDraft(initial);
					setTimeout(() => e.target.blur());
				}
			}}
			title={title || field.editor.hint || "Click to change"}
		/>
	);
}

function SettingRow({ field, settings, originalSettings, changed, editable, onChange }) {
	const commit = (value) =>
		onChange(field.toPatch ? field.toPatch(value, settings, originalSettings) : { [field.key]: value });
	const tooltip = changed ? `Changed — the customer chose ${field.display(originalSettings)}` : undefined;
	return (
		<div className={`file-preview__spec ${changed ? "file-preview__spec--changed" : ""}`} title={tooltip}>
			<span className="file-preview__spec-label">{field.label}</span>
			{editable ? (
				field.editor.type === "select" ? (
					<SelectControl field={field} settings={settings} onCommit={commit} title={tooltip} />
				) : (
					<InputControl field={field} settings={settings} onCommit={commit} title={tooltip} />
				)
			) : (
				<span
					className="file-preview__spec-value"
					title={tooltip || String(field.display(settings))}
					style={field.capitalize ? { textTransform: "capitalize" } : undefined}
				>
					{field.display(settings)}
				</span>
			)}
		</div>
	);
}

function FileSettingsGrid({ settings = {}, originalSettings, overriddenKeys = [], editable = false, onChange }) {
	// The engine's refusal (a malformed page range, the document just started
	// printing…) — shown under the grid until the next change.
	const [error, setError] = useState(null);

	const handleChange = async (patch) => {
		setError(null);
		try {
			const result = await onChange(patch);
			if (result && !result.success) setError(result.message || "Couldn't change this setting");
		} catch (err) {
			setError(err?.message || "Couldn't change this setting");
		}
	};

	return (
		<>
			<div className="file-preview__specs">
				{COLUMNS.map((column, i) => (
					<div key={i} className="file-preview__specs-col">
						{column.map((field) => (
							<SettingRow
								key={field.id || field.key}
								field={field}
								settings={settings}
								originalSettings={originalSettings || settings}
								changed={
									overriddenKeys.includes(field.key) &&
									(field.isChanged ? field.isChanged(settings, originalSettings || settings, overriddenKeys) : true)
								}
								editable={editable}
								onChange={handleChange}
							/>
						))}
					</div>
				))}
			</div>
			{error && <span className="file-preview__specs-error">{error}</span>}
		</>
	);
}

export default FileSettingsGrid;
