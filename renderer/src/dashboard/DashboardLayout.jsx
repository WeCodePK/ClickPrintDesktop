import { Outlet } from "react-router-dom";
import Sidebar from "./components/Sidebar";
import AutoPrintTitleStatus from "./components/AutoPrintTitleStatus";

function DashboardLayout() {
	return (
		<div className="dashboard">
			<AutoPrintTitleStatus />
			<div className="db-body">
				<Sidebar />
				<Outlet />
			</div>
		</div>
	);
}

export default DashboardLayout;
