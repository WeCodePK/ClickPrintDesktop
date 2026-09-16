import { useState, useEffect } from "react";
import Stepper from "../onboarding/Stepper";
import PrintersStep from "../onboarding/PrintersStep";
import ServicesStep from "../onboarding/ServicesStep";
import SettingsStep from "../onboarding/SettingsStep";
import { STEPS, firstIncompleteStep } from "../onboarding/setupStatus";
import { LogoutIcon } from "../dashboard/icons";

const FINISH_CELEBRATION_MS = 1600;

// First-run setup shown instead of the dashboard while printers, services or the
// shop profile are missing. There's deliberately no skip — only Back, Next, and
// Log out.
function OnboardingScreen({ shopName, initialStatus, onComplete, onLogout }) {
	const [done, setDone] = useState(initialStatus);
	const [current, setCurrent] = useState(() => firstIncompleteStep(initialStatus));
	const [direction, setDirection] = useState("forward");
	const [finished, setFinished] = useState(false);

	useEffect(() => {
		if (!finished) return;
		const timer = setTimeout(onComplete, FINISH_CELEBRATION_MS);
		return () => clearTimeout(timer);
	}, [finished, onComplete]);

	const goNext = () => {
		setDone((prev) => ({ ...prev, [STEPS[current].id]: true }));
		setDirection("forward");
		setCurrent((i) => Math.min(i + 1, STEPS.length - 1));
	};

	const goBack = () => {
		setDirection("back");
		setCurrent((i) => Math.max(i - 1, 0));
	};

	const handleFinish = () => {
		setDone((prev) => ({ ...prev, profile: true }));
		setFinished(true);
	};

	const layout = {
		step: STEPS[current],
		index: current,
		total: STEPS.length,
		direction,
		onBack: current > 0 ? goBack : null,
	};

	return (
		<div className="onb">
			<header className="onb__header">
				<div className="onb__intro">
					<div>
						<span className="onb__eyebrow">Shop setup{shopName ? ` · ${shopName}` : ""}</span>
						<h1 className="onb__title">Let’s get your shop ready to print</h1>
					</div>
					<button type="button" className="onb__logout" onClick={onLogout}>
						<LogoutIcon />
						Log out
					</button>
				</div>
				<Stepper steps={STEPS} current={finished ? STEPS.length : current} done={done} />
			</header>

			<main className="onb__main">
				{current === 0 && <PrintersStep key="printers" {...layout} onNext={goNext} />}
				{current === 1 && <ServicesStep key="services" {...layout} onNext={goNext} />}
				{current === 2 && <SettingsStep key="profile" {...layout} onFinish={handleFinish} />}
			</main>

			{finished && (
				<div className="onb-done" role="status">
					<div className="onb-done__card">
						<span className="onb-done__badge">
							<svg viewBox="0 0 24 24" width="38" height="38" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
								<polyline className="onb-done__tick" points="20 6 9 17 4 12" />
							</svg>
						</span>
						<h2 className="onb-done__title">You’re all set!</h2>
						<p className="onb-done__text">Your shop is ready to take print orders. Opening your dashboard…</p>
					</div>
				</div>
			)}
		</div>
	);
}

export default OnboardingScreen;
