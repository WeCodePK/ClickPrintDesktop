import { useState, useRef } from "react";
import { createHashRouter, RouterProvider, Navigate } from "react-router-dom";
import { JobsProvider } from "../dashboard/JobsContext";
import { FilesProvider } from "../dashboard/FilesContext";
import { AutoPrintProvider } from "../dashboard/AutoPrintContext";
import DashboardLayout from "../dashboard/DashboardLayout";
import PrintJobsTab from "../dashboard/tabs/PrintJobsTab";
import HistoryTab from "../dashboard/tabs/HistoryTab";
import DashboardTab from "../dashboard/tabs/DashboardTab";
import SettingsTab from "../dashboard/tabs/SettingsTab";

// A data router (rather than <HashRouter>) so pages can block navigation with
// useBlocker, e.g. the shop profile while it has unsaved changes.
function buildRouter(onLogout) {
	return createHashRouter([
		{
			element: <DashboardLayout onLogout={onLogout} />,
			children: [
				{ index: true, element: <Navigate to="jobs" replace /> },
				{ path: "jobs", element: <PrintJobsTab /> },
				{ path: "history", element: <HistoryTab /> },
				{ path: "home", element: <DashboardTab /> },
				// Printers and Services moved under Settings; their old paths
				// still resolve so existing links keep working.
				{ path: "printers", element: <Navigate to="/settings?section=printers" replace /> },
				{ path: "services", element: <Navigate to="/settings?section=services" replace /> },
				{ path: "profile", element: <SettingsTab initialSection="profile" /> },
				{ path: "settings", element: <SettingsTab /> },
				// Logging out is a confirmation popup from the sidebar now.
				{ path: "logout", element: <Navigate to="/jobs" replace /> },
				{ path: "*", element: <Navigate to="jobs" replace /> },
			],
		},
	]);
}

function DashboardScreen({ shopProfile, onLogout }) {
	// Build the router once: App passes a fresh onLogout each render, and a new
	// router would reset navigation. The ref always calls the latest one.
	const onLogoutRef = useRef(onLogout);
	onLogoutRef.current = onLogout;
	const [router] = useState(() => buildRouter((...args) => onLogoutRef.current?.(...args)));

	return (
		<JobsProvider>
			<FilesProvider>
				<AutoPrintProvider>
					<RouterProvider router={router} />
				</AutoPrintProvider>
			</FilesProvider>
		</JobsProvider>
	);
}

export default DashboardScreen;
