import React from "react";
import { Outlet } from "react-router-dom";
import Sidebar from "./components/Sidebar";

// Persistent dashboard shell: the left navigation sidebar plus the routed tab
// content (each tab renders its own list + detail columns via <Outlet />).
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
