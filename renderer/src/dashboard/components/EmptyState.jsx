// "Nothing here" filler for an empty list section: an illustration in a soft
// tinted circle, a title and an optional hint, centred in the space it's given.

// An empty tray — nothing waiting in the queue.
const TrayArt = () => (
	<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
		<path d="M10 36 18 16h28l8 20" />
		<path d="M10 36v12a4 4 0 0 0 4 4h36a4 4 0 0 0 4-4V36H42l-3 6H25l-3-6Z" />
		<path d="M26 24h12M29 30h6" opacity="0.5" />
	</svg>
);

// A clipboard with a tick — nothing needs the operator.
const AllClearArt = () => (
	<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
		<rect x="15" y="12" width="34" height="42" rx="5" />
		<path d="M25 12v-2a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v2" />
		<path d="m24 34 6 6 11-12" />
	</svg>
);

// A magnifier — a search that matched nothing.
const SearchArt = () => (
	<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
		<circle cx="28" cy="28" r="14" />
		<path d="m38 38 12 12" />
		<path d="M23 28h10" opacity="0.5" />
	</svg>
);

// A clock with a return arrow — no past jobs yet.
const HistoryArt = () => (
	<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
		<path d="M12 32a20 20 0 1 0 6-14.3" />
		<path d="M12 12v8h8" />
		<path d="M32 22v10l7 5" />
	</svg>
);

// A printer with a blank sheet — no printers registered yet.
const PrinterArt = () => (
	<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
		<path d="M20 24V10h24v14" />
		<rect x="10" y="24" width="44" height="20" rx="4" />
		<path d="M20 38h24v16H20z" />
		<path d="M26 44h12M26 49h8" opacity="0.5" />
		<circle cx="46" cy="31" r="1.5" fill="currentColor" stroke="none" />
	</svg>
);

// A price tag — no priced print services yet.
const ServiceArt = () => (
	<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
		<path d="M34 10H52a2 2 0 0 1 2 2v18a4 4 0 0 1-1.2 2.8L32.8 52.8a4 4 0 0 1-5.6 0L11.2 36.8a4 4 0 0 1 0-5.6L31.2 11.2A4 4 0 0 1 34 10Z" />
		<circle cx="44" cy="20" r="3" />
		<path d="M24 34l8 8M29 29l8 8" opacity="0.5" />
	</svg>
);

const ART = {
	tray: TrayArt,
	"all-clear": AllClearArt,
	search: SearchArt,
	history: HistoryArt,
	printer: PrinterArt,
	service: ServiceArt,
};

function EmptyState({ art = "tray", title, hint }) {
	const Art = ART[art] || TrayArt;
	return (
		<div className={`empty-state empty-state--${art}`}>
			<span className="empty-state__art" aria-hidden="true">
				<Art />
			</span>
			<p className="empty-state__title">{title}</p>
			{hint && <p className="empty-state__hint">{hint}</p>}
		</div>
	);
}

export default EmptyState;
