// Segmented controls shared across dashboard forms and modals.

// Single-choice segmented control.
export function Segmented({ options, value, onChange }) {
	return (
		<div className="segmented">
			{options.map((opt) => {
				const isActive = value === opt.value;
				const activeClass = opt.activeClass || "segmented__btn--active";
				return (
					<button
						key={String(opt.value)}
						type="button"
						className={`segmented__btn ${isActive ? activeClass : ""}`}
						onClick={() => onChange(opt.value)}
					>
						{opt.label}
					</button>
				);
			})}
		</div>
	);
}

// Multi-select segmented control. Each group must always keep at least one
// option selected — clicking the last remaining active option in the group is
// a no-op (with a tooltip explaining why) rather than letting it deselect.
export function MultiSegmented({ options, selectedValues, onChange }) {
	const optionValues = options.map((o) => o.value);
	const selectedInGroup = selectedValues.filter((v) => optionValues.includes(v));

	return (
		<div className="segmented">
			{options.map((opt) => {
				const isActive = selectedValues.includes(opt.value);
				const activeClass = opt.activeClass || "segmented__btn--active";
				const isLocked = isActive && selectedInGroup.length <= 1;
				const toggle = () => {
					if (isActive) {
						if (isLocked) return;
						onChange(selectedValues.filter((v) => v !== opt.value));
					} else {
						onChange([...selectedValues, opt.value]);
					}
				};
				return (
					<button
						key={String(opt.value)}
						type="button"
						className={`segmented__btn ${isActive ? activeClass : ""} ${isLocked ? "segmented__btn--locked" : ""}`}
						onClick={toggle}
						title={isLocked ? "At least one option in this group must stay selected" : undefined}
					>
						{opt.label}
					</button>
				);
			})}
		</div>
	);
}
