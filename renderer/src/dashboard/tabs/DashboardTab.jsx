import React, { useState, useEffect, useCallback, useRef } from "react";
import { computeStats } from "../statsUtils";
import { useAutoPrint } from "../AutoPrintContext";
import {
	WalletIcon,
	StackIcon,
	PagesIcon,
	BanIcon,
	TrophyIcon,
	RefreshIcon,
	PrinterIcon,
	BoltIcon,
} from "../icons";

// Animated count-up for the KPI values. Eases from 0 → target on mount / change.
function useCountUp(target, duration = 950) {
	const [value, setValue] = useState(0);
	const raf = useRef(0);

	useEffect(() => {
		const from = 0;
		const start = performance.now();
		const tick = (now) => {
			const p = Math.min(1, (now - start) / duration);
			const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
			setValue(from + (target - from) * eased);
			if (p < 1) raf.current = requestAnimationFrame(tick);
			else setValue(target);
		};
		raf.current = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf.current);
	}, [target, duration]);

	return value;
}

const rupees = (n) => `Rs. ${Math.round(n).toLocaleString("en-US")}`;

// Kanban-style KPI card with an animated value.
function KpiCard({ icon, label, value, sub, accent, currency, delay = 0 }) {
	const animated = useCountUp(value);
	const display = currency ? rupees(animated) : Math.round(animated).toLocaleString("en-US");
	return (
		<div className={`kpi-card kpi-card--${accent}`} style={{ animationDelay: `${delay}ms` }}>
			<div className="kpi-card__top">
				<span className="kpi-card__icon">{icon}</span>
				<span className="kpi-card__label">{label}</span>
			</div>
			<div className="kpi-card__value">{display}</div>
			{sub && <div className="kpi-card__sub">{sub}</div>}
		</div>
	);
}

// Earnings-per-day bar chart (last 7 days), bars grow in on mount.
function EarningsChart({ series, max }) {
	const hasData = series.some((s) => s.amount > 0);
	return (
		<div className="panel panel--span2">
			<div className="panel__head">
				<h3 className="panel__title">Earnings · last 7 days</h3>
				<span className="panel__hint">Completed jobs only</span>
			</div>
			{hasData ? (
				<div className="bars">
					{series.map((s, i) => (
						<div className="bars__col" key={s.key}>
							<span className="bars__val">{s.amount ? rupees(s.amount) : ""}</span>
							<div className="bars__track">
								<div
									className="bars__fill"
									style={{ "--h": `${(s.amount / max) * 100}%`, animationDelay: `${i * 70}ms` }}
								/>
							</div>
							<span className="bars__label">{s.label}<em>{s.day}</em></span>
						</div>
					))}
				</div>
			) : (
				<div className="panel__empty">No earnings recorded in the last 7 days.</div>
			)}
		</div>
	);
}

// Completed / cancelled / other donut.
function OutcomesPanel({ stats }) {
	const other = Math.max(0, stats.totalJobs - stats.completedCount - stats.cancelledCount);
	const total = Math.max(1, stats.totalJobs);
	const completedPct = (stats.completedCount / total) * 100;
	const cancelledPct = (stats.cancelledCount / total) * 100;
	const donut = `conic-gradient(
		var(--color-primary) 0 ${completedPct}%,
		var(--color-accent) ${completedPct}% ${completedPct + cancelledPct}%,
		var(--color-text-muted) ${completedPct + cancelledPct}% 100%
	)`;

	return (
		<div className="panel">
			<div className="panel__head">
				<h3 className="panel__title">Job Outcomes</h3>
			</div>
			<div className="outcomes">
				<div className="donut" style={{ background: donut }}>
					<div className="donut__hole">
						<span className="donut__pct">{stats.completionRate}%</span>
						<span className="donut__cap">done</span>
					</div>
				</div>
				<ul className="legend">
					<li><span className="legend__dot legend__dot--ok" />Completed<b>{stats.completedCount}</b></li>
					<li><span className="legend__dot legend__dot--bad" />Cancelled<b>{stats.cancelledCount}</b></li>
					<li><span className="legend__dot legend__dot--mut" />In&nbsp;progress<b>{other}</b></li>
				</ul>
			</div>
		</div>
	);
}

// Most-demanded services ranking with animated bars.
function ServicesPanel({ services, maxUnits }) {
	return (
		<div className="panel">
			<div className="panel__head">
				<h3 className="panel__title">Most Demanded Services</h3>
				<span className="panel__hint"><TrophyIcon /></span>
			</div>
			{services.length ? (
				<div className="rank-list">
					{services.map((s, i) => (
						<div className="rank" key={s.code}>
							<span className="rank__rank">{i + 1}</span>
							<div className="rank__body">
								<div className="rank__top">
									<span className="rank__name">{s.code}</span>
									<span className="rank__val">{s.units} <em>pg</em></span>
								</div>
								<div className="rank__track">
									<div
										className="rank__fill"
										style={{ "--w": `${(s.units / maxUnits) * 100}%`, animationDelay: `${i * 90}ms` }}
									/>
								</div>
							</div>
						</div>
					))}
				</div>
			) : (
				<div className="panel__empty">No service data yet.</div>
			)}
		</div>
	);
}

function TotalsPanel({ stats }) {
	const rows = [
		{ label: "Total revenue", value: rupees(stats.totalRevenue) },
		{ label: "Total jobs", value: stats.totalJobs.toLocaleString("en-US") },
		{ label: "Avg. order value", value: rupees(stats.avgOrder) },
		{ label: "Pages printed", value: stats.totalPages.toLocaleString("en-US") },
		{ label: "Completion rate", value: `${stats.completionRate}%` },
		{ label: "Cancellation rate", value: `${stats.cancellationRate}%` },
	];
	return (
		<div className="panel">
			<div className="panel__head">
				<h3 className="panel__title">All-time Summary</h3>
			</div>
			<div className="totals">
				{rows.map((r) => (
					<div className="totals__row" key={r.label}>
						<span className="totals__label">{r.label}</span>
						<span className="totals__value">{r.value}</span>
					</div>
				))}
			</div>
		</div>
	);
}

// Dashboard tab — analytics computed from GET /api/history.
function DashboardTab() {
	const { autoPrintEnabled, queueCount, selectedPrinter: printer } = useAutoPrint();
	const [stats, setStats] = useState(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await window.electronAPI.fetchHistory();
			if (result.success) {
				setStats(computeStats(result.data || []));
			} else {
				setError(result.message || "Failed to load history.");
			}
		} catch (err) {
			console.error("[Renderer] failed to load dashboard:", err);
			setError("Failed to load history.");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	return (
		<div className="dash">
			<div className="dash__header">
				<div>
					<h1 className="dash__title">Dashboard</h1>
					<p className="dash__sub">
						{stats
							? `Live overview · updated ${stats.generatedAt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`
							: "Live overview of your print shop"}
					</p>
				</div>
				<button className="dash__refresh" onClick={load} disabled={loading}>
					<RefreshIcon />
					Refresh
				</button>
			</div>

			{loading ? (
				<div className="dash__state">
					<div className="spinner spinner--dark" />
					<p>Crunching the numbers…</p>
				</div>
			) : error ? (
				<div className="dash__state">
					<p className="dash__error">{error}</p>
					<button className="btn-outline" style={{ flex: "0 0 auto" }} onClick={load}>Try again</button>
				</div>
			) : stats ? (
				<>
					<div className="kpi-row">
						<KpiCard
							accent="primary"
							currency
							icon={<WalletIcon />}
							label="Today's Earnings"
							value={stats.todayRevenue}
							sub={`${stats.todayCompleted} completed today`}
							delay={70}
						/>
						<KpiCard
							accent="blue"
							icon={<StackIcon />}
							label="Print Requests Today"
							value={stats.todayRequests}
							sub="new jobs received"
							delay={140}
						/>
						<KpiCard
							accent="violet"
							icon={<PagesIcon />}
							label="Pages Printed Today"
							value={stats.todayPages}
							sub="across completed jobs"
							delay={210}
						/>
						<KpiCard
							accent="danger"
							icon={<BanIcon />}
							label="Cancelled Jobs"
							value={stats.cancelledCount}
							sub={`${stats.cancellationRate}% of all jobs`}
							delay={280}
						/>
						<div className="kpi-card kpi-card--slate" style={{ animationDelay: "0ms" }}>
							<div className="kpi-card__top">
								<span className="kpi-card__icon"><PrinterIcon /></span>
								<span className="kpi-card__label">Selected Printer</span>
							</div>
							<div className="kpi-card__value kpi-card__value--text" title={printer?.displayName || ""}>
								{printer?.displayName || "Not set"}
							</div>
							<div className="kpi-card__sub">
								{printer ? "Used for all print jobs" : "Choose one in the Printers tab"}
							</div>
						</div>
						<div className={`kpi-card ${autoPrintEnabled ? "kpi-card--primary" : "kpi-card--slate"}`} style={{ animationDelay: "35ms" }}>
							<div className="kpi-card__top">
								<span className="kpi-card__icon"><BoltIcon /></span>
								<span className="kpi-card__label">Automated Printing</span>
							</div>
							<div className="kpi-card__value kpi-card__value--text">
								{autoPrintEnabled ? "On" : "Off"}
							</div>
							<div className="kpi-card__sub">
								{autoPrintEnabled
									? queueCount > 0
										? `${queueCount} job${queueCount === 1 ? "" : "s"} in queue`
										: "Waiting for jobs"
									: "Jobs printed manually"}
							</div>
						</div>
					</div>

					<div className="dash__grid">
						<EarningsChart series={stats.series} max={stats.maxSeries} />
						<OutcomesPanel stats={stats} />
						<ServicesPanel services={stats.topServices} maxUnits={stats.topServiceUnits} />
						<TotalsPanel stats={stats} />
					</div>
				</>
			) : null}
		</div>
	);
}

export default DashboardTab;
