import JobCode from "./JobCode";
import ChannelIcon from "./ChannelIcon";
import { statusTone, formatPhone } from "../jobUtils";

// One job in a job list (Print Jobs queue, History): queue position (when it has
// one); the job code and status badge, with "name · number" under them in a
// smaller font; the channel icon above the time on the right. `footer` is an
// optional line underneath (the queue / attention hint).
function JobListCard({ entry, position = null, time, selected = false, attention = false, footer = null, onClick }) {
	const name = entry.createdBy?.name;
	const number = formatPhone(entry.createdBy?.number);
	return (
		<button
			className={`db-entry db-entry--job ${selected ? "db-entry--top" : ""} ${attention ? "db-entry--attention" : ""}`}
			onClick={onClick}
		>
			{position != null && <span className="db-entry__qnum">{position}</span>}
			<div className="db-entry__info">
				<div className="db-entry__line">
					<span className="db-entry__main">
						<span className="db-entry__code-row">
							<JobCode code={entry.code} />
							<span className={`db-status db-status--${statusTone(entry)} db-entry__status`}>
								{entry.rawStatus || entry.status}
							</span>
						</span>
						<span className="db-entry__who">
							{name || (number ? null : "Customer")}
							{name && number && <span className="db-entry__who-sep"> · </span>}
							{number && <span className="db-entry__who-number">{number}</span>}
						</span>
					</span>
					<span className="db-entry__stack">
						<ChannelIcon channel={entry.channel} />
						<span className="db-entry__time">{time ?? entry.time}</span>
					</span>
				</div>
				{footer}
			</div>
		</button>
	);
}

export default JobListCard;
