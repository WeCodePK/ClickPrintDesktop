import InfoTip from "./InfoTip";
import { CheckIcon } from "../dashboard/icons";

// Horizontal progress indicator. Steps before the current one are necessarily
// done; later ones show as done when they were already configured.
function Stepper({ steps, current, done }) {
	const progress = steps.length > 1 ? Math.min(100, (current / (steps.length - 1)) * 100) : 0;

	return (
		<ol className="onb-stepper" style={{ "--onb-steps": steps.length, "--onb-progress": `${progress}%` }}>
			<li className="onb-stepper__track" aria-hidden="true">
				<span className="onb-stepper__fill" />
			</li>
			{steps.map((step, i) => {
				const Icon = step.Icon;
				const state = i === current ? "current" : i < current || done[step.id] ? "done" : "upcoming";
				return (
					<li
						key={step.id}
						className={`onb-stepper__item onb-stepper__item--${state}`}
						aria-current={state === "current" ? "step" : undefined}
					>
						<span className="onb-stepper__dot">
							{state === "done" ? (
								<span className="onb-stepper__check" key="check"><CheckIcon /></span>
							) : (
								<Icon />
							)}
						</span>
						<span className="onb-stepper__num">Step {i + 1}</span>
						<span className="onb-stepper__label">
							{step.label}
							<InfoTip text={step.info} label={`About the ${step.label} step`} />
						</span>
					</li>
				);
			})}
		</ol>
	);
}

export default Stepper;
