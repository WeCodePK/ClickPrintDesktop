import { Outlet } from "react-router-dom";
import Sidebar from "./components/Sidebar";
import AutoPrintTitleStatus from "./components/AutoPrintTitleStatus";

function DashboardLayout({ onLogout }) {
	return (
		<div className="dashboard">
			<AutoPrintTitleStatus />
			<div className="db-body">
				<Sidebar onLogout={onLogout} />
				<Outlet />
			</div>
		</div>
	);
}

export default DashboardLayout;
