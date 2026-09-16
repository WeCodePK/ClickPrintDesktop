import { PrinterIcon, WalletIcon, SettingsIcon } from "../dashboard/icons";

export const STEPS = [
	{
		id: "printers",
		label: "Printers",
		Icon: PrinterIcon,
		title: "Add your printers",
		description: "Choose the printers on this computer that ClickPrint should send customer documents to.",
		info:
			"Every order is printed on one of the printers you add here. Tick each printer your shop uses — offline printers can be added too and start working once they're switched on. Select at least one to continue.",
	},
	{
		id: "services",
		label: "Services",
		Icon: WalletIcon,
		title: "Create your services",
		description: "Services are the print options customers can order, each with your price per page.",
		info:
			"A service is a paper size + colour + single/double-sided combination with a rate per page. Assign the printers that handle it and whether each may print it automatically. Customers can only order the services you create — add at least one to continue.",
	},
	{
		id: "profile",
		label: "Configuration",
		Icon: SettingsIcon,
		title: "Configure your shop",
		description: "Set how the app runs on this computer, where your earnings are paid, and when you're open.",
		info:
			"App preferences apply to this computer only. Your shop profile — payout wallet, contact number and opening hours — is shown to customers and used to pay you. Wallet, contact number and timings are required to finish setup.",
	},
];

// Which parts of shop setup are in place, keyed by step id. Throws when any part
// can't be checked, so a network failure is never mistaken for a finished setup.
export async function checkSetup() {
	const [printers, services, shop] = await Promise.all([
		window.electronAPI.fetchPrinters(),
		window.electronAPI.fetchServices(),
		window.electronAPI.fetchShop(),
	]);
	const failed = [printers, services, shop].find((result) => !result?.success);
	if (failed) throw new Error(failed?.message || "Couldn't check your shop setup.");

	const s = shop.data || {};
	return {
		printers: (printers.data || []).length > 0,
		services: (services.data || []).length > 0,
		profile: Boolean(
			s.wallet?.bank &&
				s.wallet?.title &&
				s.wallet?.number &&
				String(s.contactNumber || "").trim() &&
				Array.isArray(s.timings) &&
				s.timings.length > 0
		),
	};
}

export const isSetupComplete = (status) => STEPS.every((step) => status[step.id]);

export const firstIncompleteStep = (status) => Math.max(0, STEPS.findIndex((step) => !status[step.id]));
