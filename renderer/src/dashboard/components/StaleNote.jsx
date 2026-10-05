import { formatSavedAt } from "../useNetStatus";

// One line above a list fed by the saved copy rather than a fresh fetch:
// "Offline — showing data saved at 10:41". Renders nothing when the data is fresh.
function StaleNote({ stale, fetchedAt, children }) {
	if (!stale) return null;
	const at = formatSavedAt(fetchedAt);
	return (
		<div className="stale-note" role="status">
			{children || <>Offline — showing data saved{at ? ` at ${at}` : " earlier"}.</>}
		</div>
	);
}

export default StaleNote;
