import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { JobsProvider } from "../dashboard/JobsContext";
import { FilesProvider } from "../dashboard/FilesContext";
import { AutoPrintProvider } from "../dashboard/AutoPrintContext";
import DashboardLayout from "../dashboard/DashboardLayout";
import PrintJobsTab from "../dashboard/tabs/PrintJobsTab";
import PrintersTab from "../dashboard/tabs/PrintersTab";
import HistoryTab from "../dashboard/tabs/HistoryTab";
import DashboardTab from "../dashboard/tabs/DashboardTab";
import ServicesTab from "../dashboard/tabs/ServicesTab";
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
								<Route path="printers" element={<PrintersTab />} />
								<Route path="history" element={<HistoryTab />} />
								<Route path="home" element={<DashboardTab />} />
								<Route path="services" element={<ServicesTab />} />
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
