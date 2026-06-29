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

// Oldest → newest list of the last `n` day-keys, including today.
function lastNDays(n, ref) {
	const out = [];
	for (let i = n - 1; i >= 0; i--) {
		const d = new Date(ref);
		d.setDate(ref.getDate() - i);
		out.push({
			key: dateKey(d.toISOString()),
			label: d.toLocaleDateString("en-US", { weekday: "short" }),
			day: d.getDate(),
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
			if (today) {
				todayRevenue += amount;
				todayPages += pages;
				todayCompleted++;
			}
		}
	}

	const series = lastNDays(7, now).map((d) => ({ ...d, amount: earningsByDate[d.key] || 0 }));
	const maxSeries = Math.max(1, ...series.map((s) => s.amount));

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
		series,
		maxSeries,
		topServices,
		topServiceUnits,
		mostDemanded: topServices[0] || null,
		generatedAt: now,
	};
}
