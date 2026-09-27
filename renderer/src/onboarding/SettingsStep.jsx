import { useState } from "react";
import StepLayout from "./StepLayout";
import InfoTip from "./InfoTip";
import ShopProfileSettings from "../dashboard/components/settings/ShopProfileSettings";
import { StoreIcon } from "../dashboard/icons";

const PROFILE_FORM_ID = "onboarding-profile-form";

// Step 3: the shop profile. The footer's Finish button submits its form.
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
