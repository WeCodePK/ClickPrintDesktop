import React from "react";
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { JobsProvider } from "../dashboard/JobsContext";
import { FilesProvider } from "../dashboard/FilesContext";
import DashboardLayout from "../dashboard/DashboardLayout";
import PrintJobsTab from "../dashboard/tabs/PrintJobsTab";
import PrintersTab from "../dashboard/tabs/PrintersTab";
import HistoryTab from "../dashboard/tabs/HistoryTab";
import DashboardTab from "../dashboard/tabs/DashboardTab";
import SettingsTab from "../dashboard/tabs/SettingsTab";
import LogoutTab from "../dashboard/tabs/LogoutTab";

// Dashboard entry point. Wires the shared jobs state and a hash router (works
// under file:// in packaged builds) over the persistent dashboard layout. Each
// route renders a self-contained tab.
function DashboardScreen({ shopProfile, onLogout }) {
	return (
		<JobsProvider>
			<FilesProvider>
				<HashRouter>
					<Routes>
						<Route element={<DashboardLayout />}>
							<Route index element={<Navigate to="jobs" replace />} />
							<Route path="jobs" element={<PrintJobsTab />} />
							<Route path="printers" element={<PrintersTab />} />
							<Route path="history" element={<HistoryTab />} />
							<Route path="home" element={<DashboardTab />} />
							<Route path="settings" element={<SettingsTab />} />
							<Route path="logout" element={<LogoutTab onLogout={onLogout} />} />
							<Route path="*" element={<Navigate to="jobs" replace />} />
						</Route>
					</Routes>
				</HashRouter>
			</FilesProvider>
		</JobsProvider>
	);
}

export default DashboardScreen;
