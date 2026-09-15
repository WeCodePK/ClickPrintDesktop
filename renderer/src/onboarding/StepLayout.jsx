import InfoTip from "./InfoTip";

// Shared frame for an onboarding step: animated header + content, and a footer
// with Back / Next. The body slides in from the side the operator is heading
// toward, so moving forward and going back feel distinct.
function StepLayout({
	step,
	index,
	total,
	direction,
	onBack,
	onNext,
	nextLabel = "Continue",
	busyLabel = "Saving…",
	nextDisabled = false,
	busy = false,
	hint,
	nextProps,
	children,
}) {
	const Icon = step.Icon;

	return (
		<div className="onb-step">
			<div className="onb-step__scroll">
				<div className={`onb-step__body onb-step__body--${direction}`}>
					<div className="onb-step__head">
						<span className="onb-step__icon"><Icon /></span>
						<div className="onb-step__heading">
							<span className="onb-step__count">Step {index + 1} of {total}</span>
							<h2 className="onb-step__title">
								{step.title}
								<InfoTip text={step.info} label={`About ${step.title}`} />
							</h2>
							<p className="onb-step__desc">{step.description}</p>
						</div>
					</div>
					{children}
				</div>
			</div>

			<footer className="onb-footer">
				{onBack ? (
					<button type="button" className="btn-outline onb-footer__back" onClick={onBack} disabled={busy}>
						<span className="onb-footer__arrow onb-footer__arrow--back">←</span>
						Back
					</button>
				) : (
					<span />
				)}
				<div className="onb-footer__right">
					{hint && !busy && (
						<span className="onb-footer__hint" key={hint}>
							{hint}
						</span>
					)}
					<button
						type="button"
						className="btn-gradient onb-footer__next"
						onClick={onNext}
						disabled={nextDisabled || busy}
						{...nextProps}
					>
						{busy ? (
							<>
								<span className="spinner onb-footer__spinner" />
								{busyLabel}
							</>
						) : (
							<>
								{nextLabel}
								<span className="onb-footer__arrow">→</span>
							</>
						)}
					</button>
				</div>
			</footer>
		</div>
	);
}

export default StepLayout;
