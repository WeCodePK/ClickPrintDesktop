import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { JobsProvider } from "../dashboard/JobsContext";
import { FilesProvider } from "../dashboard/FilesContext";
import { AutoPrintProvider } from "../dashboard/AutoPrintContext";
import DashboardLayout from "../dashboard/DashboardLayout";
import PrintJobsTab from "../dashboard/tabs/PrintJobsTab";
import HistoryTab from "../dashboard/tabs/HistoryTab";
import DashboardTab from "../dashboard/tabs/DashboardTab";
import SettingsTab from "../dashboard/tabs/SettingsTab";
import LogoutTab from "../dashboard/tabs/LogoutTab";

function DashboardScreen({ shopProfile, onLogout }) {
	return (
		<JobsProvider>
			<FilesProvider>
				<AutoPrintProvider>
					<HashRouter>
						<Routes>
							<Route element={<DashboardLayout />}>
								<Route index element={<Navigate to="jobs" replace />} />
								<Route path="jobs" element={<PrintJobsTab />} />
								<Route path="history" element={<HistoryTab />} />
								<Route path="home" element={<DashboardTab />} />
								{/* Printers and Services moved under Settings; their old paths
								    still resolve so existing links keep working. */}
								<Route path="printers" element={<Navigate to="/settings?section=printers" replace />} />
								<Route path="services" element={<Navigate to="/settings?section=services" replace />} />
								<Route path="profile" element={<SettingsTab initialSection="profile" />} />
								<Route path="settings" element={<SettingsTab />} />
								<Route path="logout" element={<LogoutTab onLogout={onLogout} />} />
								<Route path="*" element={<Navigate to="jobs" replace />} />
							</Route>
						</Routes>
					</HashRouter>
				</AutoPrintProvider>
			</FilesProvider>
		</JobsProvider>
	);
}

export default DashboardScreen;
