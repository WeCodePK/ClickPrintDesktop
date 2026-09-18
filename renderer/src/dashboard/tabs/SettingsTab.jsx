import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import ListColumn from "../components/ListColumn";
import AppSettings from "../components/settings/AppSettings";
import ShopProfileSettings from "../components/settings/ShopProfileSettings";
import PrintersTab from "./PrintersTab";
import ServicesTab from "./ServicesTab";
import { SettingsIcon, StoreIcon, PrinterIcon, WalletIcon } from "../icons";

const SECTIONS = [
	{
		id: "app",
		label: "App Settings",
		description: "Startup and desktop preferences",
		Icon: SettingsIcon,
	},
	{
		id: "profile",
		label: "Shop Profile",
		description: "Manage shop details, location & timings",
		Icon: StoreIcon,
	},
	{
		id: "printers",
		label: "Printers",
		description: "Register, test and disable printers",
		Icon: PrinterIcon,
	},
	{
		id: "services",
		label: "Services",
		description: "Priced print options and their printers",
		Icon: WalletIcon,
	},
];

// Printers and Services need both a list column and a detail pane of their own,
// which won't fit beside the section list at the app's minimum width — so they
// take over the whole area and offer a way back to the section list.
const FULL_PANE_SECTIONS = { printers: PrintersTab, services: ServicesTab };

// Settings tab — a left navigation column of setting sections with the selected
// section's management UI rendering in the right detail pane.
function SettingsTab({ initialSection = "app" }) {
	const [searchParams, setSearchParams] = useSearchParams();
	const sectionParam = searchParams.get("section");

	const [activeSection, setActiveSection] = useState(() => {
		if (sectionParam && SECTIONS.some((s) => s.id === sectionParam)) {
			return sectionParam;
		}
		return initialSection;
	});

	useEffect(() => {
		if (sectionParam && SECTIONS.some((s) => s.id === sectionParam)) {
			setActiveSection(sectionParam);
		} else if (initialSection) {
			setActiveSection(initialSection);
		}
	}, [sectionParam, initialSection]);

	const handleSelectSection = (id) => {
		setActiveSection(id);
		setSearchParams({ section: id }, { replace: true });
	};

	const FullPaneSection = FULL_PANE_SECTIONS[activeSection];
	if (FullPaneSection) {
		return <FullPaneSection onBack={() => handleSelectSection("app")} />;
	}

	return (
		<>
			<ListColumn title="Settings">
				{SECTIONS.map((s) => {
					const Icon = s.Icon;
					const isActive = activeSection === s.id;
					return (
						<button
							key={s.id}
							type="button"
							className={`db-entry ${isActive ? "db-entry--active" : ""}`}
							onClick={() => handleSelectSection(s.id)}
						>
							<div className="db-entry__avatar db-entry__avatar--secondary">
								<Icon />
							</div>
							<div className="db-entry__info">
								<span className="db-entry__name">{s.label}</span>
								<span className="db-entry__meta">{s.description}</span>
							</div>
						</button>
					);
				})}
			</ListColumn>

			<div className="db-detail">
				{activeSection === "profile" ? (
					<ShopProfileSettings />
				) : (
					<AppSettings />
				)}
			</div>
		</>
	);
}

export default SettingsTab;
