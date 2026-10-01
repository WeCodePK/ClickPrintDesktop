import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import UpdateToast from "./components/UpdateToast";
import "./styles/global.css";

ReactDOM.createRoot(document.getElementById("root")).render(
	<React.StrictMode>
		<App />
		<UpdateToast />
	</React.StrictMode>
);
