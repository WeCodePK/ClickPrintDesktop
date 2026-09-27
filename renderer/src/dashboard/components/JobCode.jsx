import { formatJobCode } from "../jobUtils";

// A job's 4-digit code as a small badge. Renders nothing for a job without one.
function JobCode({ code, large = false }) {
	const label = formatJobCode(code);
	if (!label) return null;
	return (
		<span className={`job-code ${large ? "job-code--lg" : ""}`} title="Job code">
			{label}
		</span>
	);
}

export default JobCode;
