import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import ListColumn from "../components/ListColumn";
import AppSettings from "../components/settings/AppSettings";
import ShopProfileSettings from "../components/settings/ShopProfileSettings";
import { SettingsIcon, StoreIcon } from "../icons";

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
		description: "Manage shop name, address & capabilities",
		Icon: StoreIcon,
	},
];

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
