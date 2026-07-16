// ── History → analytics helpers ───────────────────────────────────────────────
// Turns the raw GET /api/history payload into the numbers the Dashboard renders.
// Only "completed" jobs count as revenue; "cancelled" jobs earn nothing.

function dateKey(iso) {
	const d = new Date(iso);
	// Local YYYY-MM-DD so "today" matches the operator's wall clock.
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isSameDay(iso, ref) {
	const d = new Date(iso);
	return (
		d.getFullYear() === ref.getFullYear() &&
		d.getMonth() === ref.getMonth() &&
		d.getDate() === ref.getDate()
	);
}

function startOfDay(d) {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Sums every day in `earningsByDate` (keys are "YYYY-MM-DD") whose date falls in
// [start, end).
function sumEarningsInRange(earningsByDate, start, end) {
	let total = 0;
	for (const key in earningsByDate) {
		const [y, m, d] = key.split("-").map(Number);
		const date = new Date(y, m - 1, d);
		if (date >= start && date < end) total += earningsByDate[key];
	}
	return total;
}

// Builds the earnings-chart series for a given range, bucketing daily for a
// week, weekly for a month, and monthly for six months (fewer, more legible
// bars as the window widens). `earningsByDate` comes from computeStats().
export const EARNINGS_RANGES = [
	{ value: "24h", label: "24 Hours" },
	{ value: "7d", label: "7 Days" },
	{ value: "1m", label: "1 Month" },
	{ value: "6m", label: "6 Months" },
];

export function buildEarningsSeries(earningsByDate, range, ref = new Date(), completedJobs = []) {
	const today = startOfDay(ref);

	if (range === "24h") {
		const base = new Date(ref);
		base.setHours(base.getHours() + 1, 0, 0, 0); // align to next hour boundary

		const out = [];
		const fmtHour = (d) => {
			let hours = d.getHours();
			const ampm = hours >= 12 ? "pm" : "am";
			hours = hours % 12;
			hours = hours ? hours : 12;
			return `${hours}${ampm}`;
		};

		for (let i = 5; i >= 0; i--) {
			const start = new Date(base.getTime() - (i + 1) * 4 * 3600 * 1000);
			const end = new Date(base.getTime() - i * 4 * 3600 * 1000);
			
			// Sum earnings from completedJobs in this 4-hour block
			let amount = 0;
			for (const job of completedJobs) {
				const jobDate = new Date(job.createdAt);
				if (jobDate >= start && jobDate < end) {
					amount += job.amount;
				}
			}

			out.push({
				key: `h-${start.getTime()}`,
				label: `${fmtHour(start)} - ${fmtHour(end)}`,
				day: start.toLocaleDateString("en-US", { weekday: "short" }),
				amount,
			});
		}
		return out;
	}

	if (range === "6m") {
		const out = [];
		for (let i = 5; i >= 0; i--) {
			const start = new Date(today.getFullYear(), today.getMonth() - i, 1);
			const end = new Date(today.getFullYear(), today.getMonth() - i + 1, 1);
			out.push({
				key: `${start.getFullYear()}-${start.getMonth()}`,
				label: start.toLocaleDateString("en-US", { month: "short" }),
				day: start.getFullYear() !== today.getFullYear() ? `'${String(start.getFullYear()).slice(-2)}` : "",
				amount: sumEarningsInRange(earningsByDate, start, end),
			});
		}
		return out;
	}

	if (range === "1m") {
		// 5 weekly buckets covering the last 35 days, oldest first. Label is the
		// full "Jul 3 - Jul 10" range so each bar is self-explanatory.
		const out = [];
		for (let i = 4; i >= 0; i--) {
			const end = new Date(today);
			end.setDate(today.getDate() - i * 7 + 1); // exclusive end
			const start = new Date(end);
			start.setDate(end.getDate() - 7);
			const lastDay = new Date(end);
			lastDay.setDate(end.getDate() - 1);
			const fmt = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
			out.push({
				key: `w-${start.getTime()}`,
				label: `${fmt(start)} - ${fmt(lastDay)}`,
				day: "",
				amount: sumEarningsInRange(earningsByDate, start, end),
			});
		}
		return out;
	}

	// "7d" (default): daily buckets.
	const out = [];
	for (let i = 6; i >= 0; i--) {
		const start = new Date(today);
		start.setDate(today.getDate() - i);
		const end = new Date(start);
		end.setDate(start.getDate() + 1);
		out.push({
			key: dateKey(start),
			label: start.toLocaleDateString("en-US", { weekday: "short" }),
			day: start.getDate(),
			amount: sumEarningsInRange(earningsByDate, start, end),
		});
	}
	return out;
}

// Pages in a job: prefer the priced line quantities (what was actually charged),
// falling back to copies across files.
function jobPages(job) {
	const lines = job.cost?.lines || [];
	const fromLines = lines.reduce((sum, l) => sum + (Number(l[1]) || 0), 0);
	if (fromLines > 0) return fromLines;
	return (job.files || []).reduce((sum, f) => sum + (Number(f.settings?.numberOfCopies) || 1), 0);
}

export function computeStats(history = []) {
	const now = new Date();

	let totalRevenue = 0;
	let todayRevenue = 0;
	let todayRequests = 0;
	let todayPages = 0;
	let todayCompleted = 0;
	let completedCount = 0;
	let cancelledCount = 0;
	let totalPages = 0;

	const serviceCounts = {}; // code -> { code, units, jobs }
	const earningsByDate = {}; // YYYY-MM-DD -> amount
	const completedJobs = [];

	for (const job of history) {
		const today = isSameDay(job.createdAt, now);
		if (today) todayRequests++;

		if (job.status === "completed") completedCount++;
		else if (job.status === "cancelled") cancelledCount++;

		const pages = jobPages(job);

		// Service demand — weight by charged units across every cost line.
		for (const line of job.cost?.lines || []) {
			const code = line[0];
			const qty = Number(line[1]) || 1;
			if (!code) continue;
			if (!serviceCounts[code]) serviceCounts[code] = { code, units: 0, jobs: 0 };
			serviceCounts[code].units += qty;
			serviceCounts[code].jobs += 1;
		}

		// Revenue + pages only count when the job actually printed.
		if (job.status === "completed") {
			const amount = Number(job.cost?.total) || 0;
			totalRevenue += amount;
			totalPages += pages;
			earningsByDate[dateKey(job.createdAt)] = (earningsByDate[dateKey(job.createdAt)] || 0) + amount;
			completedJobs.push({
				createdAt: job.createdAt,
				amount: amount,
			});
			if (today) {
				todayRevenue += amount;
				todayPages += pages;
				todayCompleted++;
			}
		}
	}

	const topServices = Object.values(serviceCounts).sort((a, b) => b.units - a.units).slice(0, 5);
	const topServiceUnits = topServices[0]?.units || 1;

	const totalJobs = history.length;
	const completionRate = totalJobs ? Math.round((completedCount / totalJobs) * 100) : 0;
	const cancellationRate = totalJobs ? Math.round((cancelledCount / totalJobs) * 100) : 0;
	const avgOrder = completedCount ? Math.round(totalRevenue / completedCount) : 0;

	return {
		totalRevenue,
		todayRevenue,
		todayRequests,
		todayPages,
		todayCompleted,
		completedCount,
		cancelledCount,
		totalPages,
		totalJobs,
		completionRate,
		cancellationRate,
		avgOrder,
		earningsByDate,
		completedJobs,
		topServices,
		topServiceUnits,
		mostDemanded: topServices[0] || null,
		generatedAt: now,
	};
}
