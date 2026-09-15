import { InfoIcon } from "../dashboard/icons";

// Info icon that reveals an explanation on hover (or keyboard focus).
function InfoTip({ text, label = "About this step" }) {
	return (
		<span className="info-tip" tabIndex={0} aria-label={label}>
			<InfoIcon />
			<span className="info-tip__bubble" role="tooltip">
				{text}
			</span>
		</span>
	);
}

export default InfoTip;
