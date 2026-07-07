import { Outlet } from "react-router-dom";
import Sidebar from "./components/Sidebar";

function DashboardLayout() {
	return (
		<div className="dashboard">
			<div className="db-body">
				<Sidebar />
				<Outlet />
			</div>
		</div>
	);
}

export default DashboardLayout;
