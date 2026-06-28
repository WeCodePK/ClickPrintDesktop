import React, { createContext, useContext, useState, useEffect } from "react";

// Tracks the download status of job files. The main process downloads files in
// the background as jobs arrive and pushes per-file status updates over the
// `files:updated` channel. Previews read this to decide whether to embed the
// cached PDF or show a loading/placeholder state.
const FilesContext = createContext(null);

export function FilesProvider({ children }) {
	// fileId -> "downloading" | "ready" | "error"
	const [fileStatus, setFileStatus] = useState({});

	useEffect(() => {
		let cancelled = false;

		// Seed with whatever is already cached/in-flight in the main process.
		window.electronAPI.getFilesStatus().then((map) => {
			if (!cancelled && map) setFileStatus((prev) => ({ ...prev, ...map }));
		});

		const unsubscribe = window.electronAPI.onFilesUpdate((updates) => {
			if (!cancelled) setFileStatus((prev) => ({ ...prev, ...updates }));
		});

		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, []);

	return (
		<FilesContext.Provider value={{ fileStatus, fileUrl: window.electronAPI.fileUrl }}>
			{children}
		</FilesContext.Provider>
	);
}

export function useFiles() {
	const ctx = useContext(FilesContext);
	if (!ctx) throw new Error("useFiles must be used within a FilesProvider");
	return ctx;
}
