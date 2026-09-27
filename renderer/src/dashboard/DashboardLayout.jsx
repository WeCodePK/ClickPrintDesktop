import { Outlet } from "react-router-dom";
import Sidebar from "./components/Sidebar";
import AutoPrintTitleStatus from "./components/AutoPrintTitleStatus";
import ConnectionToast from "./components/ConnectionToast";

function DashboardLayout({ onLogout }) {
	return (
		<div className="dashboard">
			<AutoPrintTitleStatus />
			<div className="db-body">
				<Sidebar onLogout={onLogout} />
				<Outlet />
			</div>
			<ConnectionToast />
		</div>
	);
}

export default DashboardLayout;
