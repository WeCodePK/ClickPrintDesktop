import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import UpdateToast from "./components/UpdateToast";
// Inter ships with the app: the shop's connection can't be counted on, not
// even for the first launch.
import "@fontsource/inter/latin-300.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/inter/latin-800.css";
import "./styles/global.css";

ReactDOM.createRoot(document.getElementById("root")).render(
	<React.StrictMode>
		<App />
		<UpdateToast />
	</React.StrictMode>
);
