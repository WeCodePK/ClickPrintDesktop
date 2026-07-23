import React, { createContext, useContext, useState, useEffect, useRef } from "react";
import { transformJob } from "./jobUtils";

// Shared live job list — fetched once via GET /api/jobs and kept up-to-date over
// SSE. Both the Print Jobs and History tabs read (and mutate) this state, so it
// lives in context rather than inside a single tab.
const JobsContext = createContext(null);

export function JobsProvider({ children }) {
	const [printJobs, setPrintJobs] = useState([]);
	const [jobsLoading, setJobsLoading] = useState(true);

	// Notification "pop" played on each SSE-driven job update. The first update is
	// the initial sync on SSE connect, so we skip it to avoid a ding on login.
	const popRef = useRef(null);
	const firstUpdateRef = useRef(true);

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

		async function loadJobs() {
			setJobsLoading(true);
			try {
				const result = await window.electronAPI.fetchJobs();
				if (!cancelled && result.success) {
					setPrintJobs((result.data || []).map(transformJob));
				}
			} catch (err) {
				console.error("[Renderer] failed to load jobs:", err);
			} finally {
				if (!cancelled) setJobsLoading(false);
			}
		}

		loadJobs();

		const unsubscribe = window.electronAPI.onJobsUpdate((jobs) => {
			console.log("[Renderer] jobs:updated received —", jobs.length, "jobs");
			if (cancelled) return;

			// Ping on every SSE event except the initial connect sync.
			if (firstUpdateRef.current) {
				firstUpdateRef.current = false;
			} else if (popRef.current) {
				popRef.current.currentTime = 0;
				popRef.current.play().catch((err) =>
					console.warn("[Renderer] notification sound blocked:", err.message)
				);
			}

			try {
				setPrintJobs((jobs || []).map(transformJob));
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

	// The list is authoritative from main (jobs:updated carries the engine's own
	// status transitions) — consumers only read, never mutate.
	return (
		<JobsContext.Provider value={{ printJobs, jobsLoading }}>
			{children}
		</JobsContext.Provider>
	);
}

export function useJobs() {
	const ctx = useContext(JobsContext);
	if (!ctx) throw new Error("useJobs must be used within a JobsProvider");
	return ctx;
}
