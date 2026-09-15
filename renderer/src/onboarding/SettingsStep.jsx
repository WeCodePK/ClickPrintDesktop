import { useState } from "react";
import StepLayout from "./StepLayout";
import InfoTip from "./InfoTip";
import AppSettings from "../dashboard/components/settings/AppSettings";
import ShopProfileSettings from "../dashboard/components/settings/ShopProfileSettings";
import { SettingsIcon, StoreIcon } from "../dashboard/icons";

const PROFILE_FORM_ID = "onboarding-profile-form";

// Step 3: everything from the Settings tab. The footer's Finish button submits
// the shop profile form; app preferences save as soon as they're toggled.
function SettingsStep({ onFinish, ...layout }) {
	const [status, setStatus] = useState({ canSubmit: false, saving: false, validationError: null });

	return (
		<StepLayout
			{...layout}
			nextLabel="Finish setup"
			busyLabel="Saving profile…"
			busy={status.saving}
			nextDisabled={!status.canSubmit}
			hint={!status.canSubmit && !status.saving ? "Complete the shop profile to finish" : null}
			nextProps={{ type: "submit", form: PROFILE_FORM_ID, onClick: undefined }}
		>
			<section className="onb-section" style={{ animationDelay: "60ms" }}>
				<h3 className="onb-section__title">
					<span className="onb-section__icon"><SettingsIcon /></span>
					App preferences
					<InfoTip
						label="About app preferences"
						text="These apply to this computer only. Starting with Windows keeps orders arriving and printing after a restart, even if nobody opens ClickPrint."
					/>
				</h3>
				<AppSettings embedded />
			</section>

			<section className="onb-section" style={{ animationDelay: "140ms" }}>
				<h3 className="onb-section__title">
					<span className="onb-section__icon"><StoreIcon /></span>
					Shop profile
					<InfoTip
						label="About the shop profile"
						text="Your earnings are paid to this wallet or bank account. Customers see your contact number, map link and opening hours when they choose where to print."
					/>
				</h3>
				<ShopProfileSettings embedded formId={PROFILE_FORM_ID} onStatusChange={setStatus} onSaved={onFinish} />
			</section>
		</StepLayout>
	);
}

export default SettingsStep;
