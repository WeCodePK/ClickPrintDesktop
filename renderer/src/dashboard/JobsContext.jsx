import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from "react";
import { transformJob } from "./jobUtils";

// Shared live job list — fetched once via GET /api/jobs and kept up-to-date over
// SSE. Both the Print Jobs and History tabs read (and mutate) this state, so it
// lives in context rather than inside a single tab.
//
// While the backend can't be reached main serves the last list it saved
// (`jobsStale`, as of `jobsFetchedAt`), so the queue stays on screen and
// printable. `jobsError` is set only when there is nothing at all to show.
const JobsContext = createContext(null);

export function JobsProvider({ children }) {
	const [printJobs, setPrintJobs] = useState([]);
	const [jobsLoading, setJobsLoading] = useState(true);
	const [jobsError, setJobsError] = useState(null);
	const [meta, setMeta] = useState({ stale: false, fetchedAt: null });

	// Notification "pop" played on each SSE-driven job update. The first fresh
	// update is the initial sync on SSE connect, and a cached list is not news,
	// so neither dings.
	const popRef = useRef(null);
	const firstFreshRef = useRef(true);
	const loadRef = useRef(null);

	useEffect(() => {
		let cancelled = false;
		let objectUrl = null;

		// Load the sound as a Blob and play from an object URL. Playing the file
		// directly via its http/file URL fails in Electron with
		// ERR_CACHE_OPERATION_NOT_SUPPORTED (the media cache path isn't supported);
		// a blob URL sidesteps that.
		fetch("sounds/message-pop.mp3")
			.then((res) => res.blob())
			.then((blob) => {
				if (cancelled) return;
				objectUrl = URL.createObjectURL(blob);
				const pop = new Audio(objectUrl);
				pop.volume = 0.6;
				popRef.current = pop;
			})
			.catch((err) => console.warn("[Renderer] failed to load notification sound:", err.message));

		async function loadJobs({ silent = false } = {}) {
			if (!silent) setJobsLoading(true);
			try {
				const result = await window.electronAPI.fetchJobs();
				if (cancelled) return;
				if (result.success) {
					setPrintJobs((result.data || []).map(transformJob));
					setMeta({ stale: !!result.stale, fetchedAt: result.fetchedAt || null });
					setJobsError(null);
				} else {
					setJobsError(result.message || "Couldn't load jobs.");
				}
			} catch (err) {
				console.error("[Renderer] failed to load jobs:", err);
				if (!cancelled) setJobsError("Couldn't load jobs.");
			} finally {
				if (!cancelled && !silent) setJobsLoading(false);
			}
		}
		loadRef.current = loadJobs;

		loadJobs();

		const unsubscribe = window.electronAPI.onJobsUpdate((jobs, update = {}) => {
			console.log("[Renderer] jobs:updated received —", jobs.length, "jobs", update.stale ? "(cached)" : "");
			if (cancelled) return;

			if (!update.stale) {
				if (firstFreshRef.current) {
					firstFreshRef.current = false;
				} else if (popRef.current) {
					popRef.current.currentTime = 0;
					popRef.current.play().catch((err) =>
						console.warn("[Renderer] notification sound blocked:", err.message)
					);
				}
			}

			try {
				setPrintJobs((jobs || []).map(transformJob));
				setMeta({ stale: !!update.stale, fetchedAt: update.fetchedAt || null });
				setJobsError(null);
			} catch (err) {
				console.error("[Renderer] failed to transform jobs update:", err);
			}
		});

		return () => {
			cancelled = true;
			unsubscribe();
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, []);

	// Nothing could be loaded: try again as soon as the connection is back.
	useEffect(() => {
		if (!jobsError) return;
		return window.electronAPI.onNetStatus?.((status) => {
			if (status?.online) loadRef.current?.({ silent: true });
		});
	}, [jobsError]);

	// Manual refresh (the list header's refresh button): re-fetches the job list
	// without the full loading state, so the list stays on screen meanwhile.
	const refreshJobs = useCallback(async () => {
		await loadRef.current?.({ silent: true });
	}, []);

	// The list is authoritative from main (jobs:updated carries the engine's own
	// status transitions) — consumers only read, never mutate.
	return (
		<JobsContext.Provider
			value={{ printJobs, jobsLoading, jobsError, jobsStale: meta.stale, jobsFetchedAt: meta.fetchedAt, refreshJobs }}
		>
			{children}
		</JobsContext.Provider>
	);
}

export function useJobs() {
	const ctx = useContext(JobsContext);
	if (!ctx) throw new Error("useJobs must be used within a JobsProvider");
	return ctx;
}
