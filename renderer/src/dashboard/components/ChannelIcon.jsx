import { channelKey, channelLabel } from "../jobUtils";
import { WhatsAppIcon, WalkInIcon } from "../icons";

// Where a job came in from, as a small icon: the ClickPrint logo (app),
// WhatsApp, or a walk-in customer. The label is its tooltip.
function ChannelIcon({ channel }) {
	const key = channelKey(channel);
	const label = channelLabel(channel);
	return (
		<span className={`channel-icon channel-icon--${key}`} title={label} aria-label={label} role="img">
			{key === "app" ? (
				<img src="icon.png" alt="" />
			) : key === "whatsapp" ? (
				<WhatsAppIcon />
			) : key === "walkin" ? (
				<WalkInIcon />
			) : (
				<span className="channel-icon__text">{label}</span>
			)}
		</span>
	);
}

export default ChannelIcon;
