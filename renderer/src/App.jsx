import React, { useState, useEffect, useCallback, useRef } from "react";
import TitleBar from "./components/TitleBar";
import LoginScreen from "./screens/LoginScreen";
import OtpScreen from "./screens/OtpScreen";
import ShopSelectScreen from "./screens/ShopSelectScreen";
import DashboardScreen from "./screens/DashboardScreen";
import OnboardingScreen from "./screens/OnboardingScreen";
import { checkSetup, isSetupComplete } from "./onboarding/setupStatus";
import { LogoutIcon, RetryIcon } from "./dashboard/icons";
import { useNetStatus } from "./dashboard/useNetStatus";

// Remembers, per shop, that its setup was found complete — so a launch with no
// connection (and nothing cached yet) still opens the dashboard instead of
// stranding the operator on a setup check that can't run.
const setupOkKey = (shopId) => `clickprint:setupComplete:${shopId}`;

function rememberSetupComplete(shopId, complete) {
	if (!shopId) return;
	try {
		if (complete) localStorage.setItem(setupOkKey(shopId), "1");
		else localStorage.removeItem(setupOkKey(shopId));
	} catch {
		// Storage unavailable — the check simply runs online next time.
	}
}

function setupKnownComplete(shopId) {
	try {
		return !!shopId && localStorage.getItem(setupOkKey(shopId)) === "1";
	} catch {
		return false;
	}
}

function App() {
	const [screen, setScreen] = useState("login"); // "login" | "otp" | "selectShop" | "setup" | "onboarding" | "dashboard"
	const [phoneNumber, setPhoneNumber] = useState("");
	// { codeLength, resendInMs } from the /api/auth/otp response.
	const [otpConfig, setOtpConfig] = useState(null);
	const [shops, setShops] = useState([]); // shops to choose from after verify
	const [shopProfile, setShopProfile] = useState(null);
	const [restoring, setRestoring] = useState(true); // checking for a saved session
	const [setupStatus, setSetupStatus] = useState(null);
	const [setupError, setSetupError] = useState(null);
	const [theme, setTheme] = useState(() => {
		const savedTheme = localStorage.getItem("theme");
		if (savedTheme) return savedTheme;
		return window.matchMedia("(prefers-color-scheme: dark)").matches
			? "dark"
			: "light";
	});

	// The login screens use a compact, centred window; the rest of the app a
	// maximized one. Main applies it only when this changes (see main.js).
	const authScreen = screen === "login" || screen === "otp" || screen === "selectShop";
	useEffect(() => {
		if (restoring) return; // don't report "login" before a saved session is checked
		window.electronAPI?.setWindowMode?.(authScreen ? "auth" : "app");
	}, [authScreen, restoring]);

	useEffect(() => {
		document.documentElement.setAttribute("data-theme", theme);
		localStorage.setItem("theme", theme);
	}, [theme]);

	// Runs once per session start (restore or login): an incomplete shop setup
	// routes to onboarding instead of the dashboard. The check reads main's saved
	// copies when the backend can't be reached; if even those are missing, a shop
	// already known to be set up goes straight to the dashboard (offline banner
	// and all). Only a shop never seen complete gets the retry card.
	const shopIdRef = useRef(null);
	const runSetupCheck = useCallback(async (shopId = shopIdRef.current) => {
		shopIdRef.current = shopId;
		setSetupError(null);
		setScreen("setup");
		try {
			const status = await checkSetup();
			const complete = isSetupComplete(status);
			rememberSetupComplete(shopId, complete);
			if (complete) {
				setScreen("dashboard");
			} else {
				setSetupStatus(status);
				setScreen("onboarding");
			}
		} catch (err) {
			console.error("[Renderer] setup check failed:", err);
			if (setupKnownComplete(shopId)) {
				console.warn("[Renderer] setup check unavailable — shop was set up before, opening the dashboard");
				setScreen("dashboard");
				return;
			}
			setSetupError(err.message || "Couldn't check your shop setup.");
		}
	}, []);

	// A setup check that failed for want of a connection runs again by itself
	// once the connection is back.
	const net = useNetStatus();
	const wasOnline = useRef(net.online);
	useEffect(() => {
		const cameBack = net.online && !wasOnline.current;
		wasOnline.current = net.online;
		if (cameBack && screen === "setup" && setupError) runSetupCheck();
	}, [net.online, screen, setupError, runSetupCheck]);

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
					runSetupCheck(auth.shopId);
				}
			})
			.catch((err) => console.warn("[Renderer] session restore failed:", err))
			.finally(() => {
				if (!cancelled) setRestoring(false);
			});
		return () => {
			cancelled = true;
		};
	}, [runSetupCheck]);

	const toggleTheme = () => {
		setTheme((prev) => (prev === "dark" ? "light" : "dark"));
	};

	const navigateToOtp = (number, config) => {
		setPhoneNumber(number);
		setOtpConfig(config || null);
		setScreen("otp");
	};

	const navigateToLogin = () => {
		setShops([]);
		setScreen("login");
	};

	const enterDashboard = (profile) => {
		window.location.hash = "#/jobs";
		setShopProfile(profile);
		runSetupCheck(profile?._id || null);
	};

	const handleOnboardingComplete = useCallback(() => {
		setSetupStatus(null);
		setScreen("dashboard");
	}, []);

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
		setSetupStatus(null);
		setSetupError(null);
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

	if (screen === "setup") {
		return (
			<div className="app-container">
				<TitleBar theme={theme} onToggleTheme={toggleTheme} />
				<div className="app-content">
					<div className="onb-gate">
						{setupError ? (
							<div className="onb-gate__card">
								<h2 className="onb-gate__title">Couldn’t check your shop setup</h2>
								<p className="onb-gate__text">{setupError}</p>
								<div className="onb-gate__actions">
									<button type="button" className="btn-outline" onClick={handleLogout}>
										<LogoutIcon />
										Log out
									</button>
									<button type="button" className="btn-gradient" onClick={() => runSetupCheck()}>
										<RetryIcon />
										Try again
									</button>
								</div>
							</div>
						) : (
							<>
								<div className="spinner spinner--dark" />
								<p className="onb-gate__text">Checking your shop setup…</p>
							</>
						)}
					</div>
				</div>
			</div>
		);
	}

	if (screen === "onboarding" && setupStatus) {
		return (
			<div className="app-container">
				<TitleBar theme={theme} onToggleTheme={toggleTheme} />
				<div className="app-content">
					<OnboardingScreen
						shopName={shopProfile?.name}
						initialStatus={setupStatus}
						onComplete={handleOnboardingComplete}
						onLogout={handleLogout}
					/>
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
						otpConfig={otpConfig}
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
