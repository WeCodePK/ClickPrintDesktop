import React, { useState, useEffect } from "react";
import TitleBar from "./components/TitleBar";
import LoginScreen from "./screens/LoginScreen";
import OtpScreen from "./screens/OtpScreen";
import ShopSelectScreen from "./screens/ShopSelectScreen";
import DashboardScreen from "./screens/DashboardScreen";

function App() {
	const [screen, setScreen] = useState("login"); // "login" | "otp" | "selectShop" | "dashboard"
	const [phoneNumber, setPhoneNumber] = useState("");
	const [shops, setShops] = useState([]); // shops to choose from after verify
	const [shopProfile, setShopProfile] = useState(null);
	const [restoring, setRestoring] = useState(true); // checking for a saved session
	const [theme, setTheme] = useState(() => {
		const savedTheme = localStorage.getItem("theme");
		if (savedTheme) return savedTheme;
		return window.matchMedia("(prefers-color-scheme: dark)").matches
			? "dark"
			: "light";
	});

	useEffect(() => {
		document.documentElement.setAttribute("data-theme", theme);
		localStorage.setItem("theme", theme);
	}, [theme]);

	useEffect(() => {
		let cancelled = false;
		window.electronAPI
			.getAuthState()
			.then((auth) => {
				if (cancelled) return;
				// Only a session with a chosen shop is fully logged in — the jobs
				// stream is scoped to it (see auth:select-shop). A token without a
				// shopId means the user quit before picking one; send them to login.
				if (auth?.token && auth?.shopId) {
					window.location.hash = "#/jobs";
					setShopProfile({ _id: auth.shopId, name: auth.shopName ?? "" });
					setPhoneNumber(auth.phoneNumber || "");
					setScreen("dashboard");
				}
			})
			.catch((err) => console.warn("[Renderer] session restore failed:", err))
			.finally(() => {
				if (!cancelled) setRestoring(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const toggleTheme = () => {
		setTheme((prev) => (prev === "dark" ? "light" : "dark"));
	};

	const navigateToOtp = (number) => {
		setPhoneNumber(number);
		setScreen("otp");
	};

	const navigateToLogin = () => {
		setShops([]);
		setScreen("login");
	};

	const enterDashboard = (profile) => {
		window.location.hash = "#/jobs";
		setShopProfile(profile);
		setScreen("dashboard");
	};

	// Called once the OTP is verified. `data` is the verify response payload,
	// including data.shops (the shops this user owns). A single shop is selected
	// automatically; multiple shops route through the shop-select screen.
	const handleVerified = async (data) => {
		const list = Array.isArray(data?.shops) ? data.shops : [];
		if (list.length > 1) {
			setShops(list);
			setScreen("selectShop");
			return;
		}
		const shop = list[0];
		if (shop) {
			await window.electronAPI.selectShop(shop);
			enterDashboard({ _id: shop._id, name: shop.name });
		} else {
			// No shops in the response — nothing to scope to. Fall back to whatever
			// profile came back so the dashboard still renders (defensive; the backend
			// returns SHOP_NOT_REGISTERED for a number with no shop).
			enterDashboard(data?.profile ?? { name: "" });
		}
	};

	const handleShopSelected = (shop) => {
		enterDashboard({ _id: shop._id, name: shop.name });
	};

	const handleLogout = async () => {
		await window.electronAPI.logout();
		window.location.hash = "#/jobs";
		setShopProfile(null);
		setPhoneNumber("");
		setShops([]);
		setScreen("login");
	};

	if (restoring) {
		return (
			<div className="app-container">
				<TitleBar theme={theme} onToggleTheme={toggleTheme} />
				<div className="app-content" style={{ alignItems: "center", justifyContent: "center" }}>
					<div className="spinner spinner--dark" />
				</div>
			</div>
		);
	}

	if (screen === "dashboard" && shopProfile) {
		return (
			<div className="app-container">
				<TitleBar theme={theme} onToggleTheme={toggleTheme} />
				<div className="app-content">
					<DashboardScreen
						shopProfile={shopProfile}
						onLogout={handleLogout}
					/>
				</div>
			</div>
		);
	}

	return (
		<div className="app-container">
			<TitleBar theme={theme} onToggleTheme={toggleTheme} />
			<div className="app-content">
				{screen === "login" && <LoginScreen onOtpSent={navigateToOtp} />}
				{screen === "otp" && (
					<OtpScreen
						phoneNumber={phoneNumber}
						onBack={navigateToLogin}
						onVerified={handleVerified}
					/>
				)}
				{screen === "selectShop" && (
					<ShopSelectScreen
						shops={shops}
						onSelected={handleShopSelected}
						onCancel={handleLogout}
					/>
				)}
			</div>
		</div>
	);
}

export default App;
