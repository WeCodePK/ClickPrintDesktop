import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import ListColumn from "../components/ListColumn";
import ShopProfileSettings from "../components/settings/ShopProfileSettings";
import WhatsAppSettings from "../components/settings/WhatsAppSettings";
import PrintersTab from "./PrintersTab";
import ServicesTab from "./ServicesTab";
import { StoreIcon, PrinterIcon, WalletIcon, WhatsAppIcon } from "../icons";

const SECTIONS = [
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
	{
		id: "whatsapp",
		label: "WhatsApp",
		description: "Link your number, excluded contacts",
		Icon: WhatsAppIcon,
	},
];

// Printers and Services bring a list column and a detail pane of their own,
// which open nested to the right of the settings column. While one is open the
// settings column goes compact (see .db-list--compact) so the detail pane keeps
// room at the app's minimum width.
const NESTED_SECTIONS = { printers: PrintersTab, services: ServicesTab };

// Settings tab — a left navigation column of setting sections with the selected
// section's management UI rendering in the right detail pane.
function SettingsTab({ initialSection = "profile" }) {
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

	const NestedSection = NESTED_SECTIONS[activeSection];

	return (
		<>
			<ListColumn title="Settings" className={NestedSection ? "db-list--compact" : undefined}>
				{SECTIONS.map((s) => {
					const Icon = s.Icon;
					const isActive = activeSection === s.id;
					return (
						<button
							key={s.id}
							type="button"
							className={`db-entry ${isActive ? "db-entry--active" : ""}`}
							onClick={() => handleSelectSection(s.id)}
							title={s.label}
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

			{NestedSection ? (
				<NestedSection />
			) : (
				<div className="db-detail">
					{activeSection === "whatsapp" ? (
						<WhatsAppSettings />
					) : (
						<ShopProfileSettings />
					)}
				</div>
			)}
		</>
	);
}

export default SettingsTab;
