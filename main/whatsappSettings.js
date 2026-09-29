// Print settings as a WhatsApp customer sees them: the numbered menu of a file's
// settings, what picking a number does, and parsing typed answers. Pure — no
// Electron or Baileys imports.
//
// A file in the order is { file, settings, name, numberOfPages, duplex }, where
// `settings` is exactly what the backend gets and `duplex` is the customer's
// explicit flip choice ("long" / "short"), or null to follow the orientation.

const DEFAULT_SETTINGS = {
	color: false,
	pageType: "A4",
	pagesPerSheet: 1,
	numberOfCopies: 1,
	sidedness: "long",
	pageSelection: "",
	orientation: "portrait",
};

const MAX_COPIES = 1000;

// A filename as inline code, so WhatsApp shows it monospaced.
function code(name) {
	return `\`${String(name).replace(/`/g, "'")}\``;
}

// Menu numbers as keycap emojis: 1️⃣ … 9️⃣, 🔟, then plain digits.
function num(n) {
	if (n >= 0 && n <= 9) return `${n}️⃣`;
	return n === 10 ? "🔟" : `${n}.`;
}

function plural(count, word) {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// Double-sided flips on the long edge for portrait, the short edge for landscape.
function autoDuplex(settings) {
	return settings.orientation === "landscape" ? "short" : "long";
}

function isDouble(file) {
	return file.settings.sidedness !== "none";
}

// The file with its sidedness recomputed: single, or double with the explicit
// duplex choice if there is one, else the orientation's.
function withSides(file, double) {
	const sidedness = double ? file.duplex ?? autoDuplex(file.settings) : "none";
	return { ...file, settings: { ...file.settings, sidedness } };
}

function set(file, changes) {
	return { ...file, settings: { ...file.settings, ...changes } };
}

// The menu's settings, most-used first; `group` separates them with a blank
// line. Picking one either `toggle`s it straight away or opens a prompt — a
// list of `options` or a typed answer checked by `parse` ({ value } or
// { error }). `apply(file, value)` stores a prompt's answer.
const SETTINGS = [
	{
		key: "pageType",
		label: "Size",
		group: 0,
		show: (f) => f.settings.pageType,
		toggle: (f) => set(f, { pageType: f.settings.pageType === "A4" ? "A3" : "A4" }),
	},
	{
		key: "color",
		label: "Color",
		group: 0,
		show: (f) => (f.settings.color ? "Color" : "Black & white"),
		toggle: (f) => set(f, { color: !f.settings.color }),
	},
	{
		key: "sides",
		label: "Sides",
		group: 0,
		show: (f) => (isDouble(f) ? "Double" : "Single"),
		toggle: (f) => withSides(f, !isDouble(f)),
	},
	{
		key: "pageSelection",
		label: "Pages",
		group: 1,
		show: (f) => f.settings.pageSelection || "All",
		prompt: (f) =>
			`Which pages of ${code(f.name)} should be printed${f.numberOfPages ? ` (it has ${plural(f.numberOfPages, "page")})` : ""}?\n` +
			"For example *1-3,5* or *2-* (page 2 to the end). Reply *all* for every page, or *0* to go back.",
		parse: parsePages,
		apply: (f, value) => set(f, { pageSelection: value }),
	},
	{
		key: "numberOfCopies",
		label: "Copies",
		group: 1,
		show: (f) => String(f.settings.numberOfCopies),
		prompt: (f) => `How many copies of ${code(f.name)}?\nReply with a number from 1 to ${MAX_COPIES}, or *0* to go back.`,
		parse: parseCopies,
		apply: (f, value) => set(f, { numberOfCopies: value }),
	},
	{
		key: "pagesPerSheet",
		label: "Pages per sheet",
		group: 1,
		show: (f) => String(f.settings.pagesPerSheet),
		options: [1, 2, 4, 8, 16],
		apply: (f, value) => set(f, { pagesPerSheet: value }),
	},
	{
		key: "orientation",
		label: "Orientation",
		group: 1,
		show: (f) => (f.settings.orientation === "landscape" ? "Landscape" : "Portrait"),
		toggle: (f) => {
			const turned = set(f, { orientation: f.settings.orientation === "landscape" ? "portrait" : "landscape" });
			return isDouble(turned) ? withSides(turned, true) : turned;
		},
	},
	{
		key: "duplex",
		label: "Duplex",
		group: 1,
		visible: isDouble,
		show: (f) => `Flip on ${f.settings.sidedness} edge${f.duplex ? "" : " (auto)"}`,
		toggle: (f) => {
			const duplex = f.settings.sidedness === "long" ? "short" : "long";
			return { ...set(f, { sidedness: duplex }), duplex };
		},
	},
];

function settingByKey(key) {
	return SETTINGS.find((s) => s.key === key) || null;
}

// What each menu number does for this file: { setting } or { action: "pickFile"
// | "applyToAll" }, in display order. Duplex is last, so hiding it never
// renumbers the other settings.
function menuItems(file, fileCount) {
	const items = SETTINGS.filter((s) => !s.visible || s.visible(file)).map((setting) => ({ setting }));
	if (fileCount > 1) items.push({ action: "pickFile" }, { action: "applyToAll" });
	return items;
}

function parseCopies(answer) {
	if (!/^\d+$/.test(answer)) return { error: "Please reply with a number of copies, like *2*." };
	const copies = Number(answer);
	if (copies < 1 || copies > MAX_COPIES) return { error: `Copies must be between 1 and ${MAX_COPIES}.` };
	return { value: copies };
}

// Page ranges: comma-separated pages (3), ranges (1-4) and open ranges (2-,
// page 2 to the end). Spaces are ignored; "all" clears the selection. Pages past
// the end of the document are refused when its page count is known.
function parsePages(answer, { numberOfPages } = {}) {
	const text = answer.replace(/\s+/g, "").toLowerCase();
	if (text === "all") return { value: "" };
	const example = "Please reply like *1-3,5* or *2-*, or *all* for every page.";
	if (!/^\d+(-\d*)?(,\d+(-\d*)?)*$/.test(text)) return { error: example };
	for (const part of text.split(",")) {
		const [start, end] = part.split("-").map((n) => (n === "" ? null : Number(n)));
		if (start < 1 || (end != null && end < start)) return { error: `"${part}" isn't a valid page range. ${example}` };
		if (numberOfPages && Math.max(start, end ?? start) > numberOfPages) {
			return { error: `This file only has ${plural(numberOfPages, "page")}.` };
		}
	}
	return { value: text };
}

// "(3 pages · file 2 of 2)" for a file of the order, or "" when there's
// neither a page count nor more than one file.
function fileDetails(file, index, fileCount) {
	const details = [
		file.numberOfPages ? plural(file.numberOfPages, "page") : null,
		fileCount > 1 ? `file ${index + 1} of ${fileCount}` : null,
	].filter(Boolean);
	return details.length ? `(${details.join(" · ")})` : "";
}

// The numbered settings menu for one file of the order.
function settingsMenu(file, fileCount) {
	const lines = [];
	let group = null;
	menuItems(file, fileCount).forEach((item, i) => {
		const itemGroup = item.setting ? item.setting.group : "files";
		if (group !== null && itemGroup !== group) lines.push("");
		group = itemGroup;
		if (item.setting) lines.push(`${num(i + 1)} ${item.setting.label}: ${item.setting.show(file)}`);
		else if (item.action === "pickFile") lines.push(`${num(i + 1)} Change another file's settings`);
		else lines.push(`${num(i + 1)} Use these settings for all files`);
	});
	return lines.join("\n");
}

// The question asked after picking a setting that isn't a toggle.
function settingPrompt(setting, file) {
	if (setting.options) {
		const current = file.settings[setting.key];
		const options = setting.options.map((o, i) => `${num(i + 1)} ${o}${o === current ? " ✓" : ""}`);
		return `*${setting.label}* for ${code(file.name)}:\n${options.join("\n")}\n\nReply with a number, or *0* to go back.`;
	}
	return setting.prompt(file);
}

// Parses the answer to settingPrompt: { value } or { error }.
function parseSettingAnswer(setting, answer, file) {
	if (setting.options) {
		const n = /^\d+$/.test(answer) ? Number(answer) : NaN;
		const option = setting.options[n - 1];
		return option !== undefined ? { value: option } : { error: `Please reply with a number from 1 to ${setting.options.length}.` };
	}
	return setting.parse(answer, file);
}

function filePrompt(files, selected) {
	const lines = files.map((f, i) => `${num(i + 1)} ${code(f.name)}${i === selected ? " ✓" : ""}`);
	return `Which file's settings do you want to change?\n${lines.join("\n")}\n\nReply with a number, or *0* to go back.`;
}

// One line per file for the order summary: size, color and sides always, then
// whatever differs from the defaults.
function fileSummary(file) {
	const s = file.settings;
	const parts = [s.pageType, s.color ? "Color" : "Black & white", isDouble(file) ? "Double-sided" : "Single-sided"];
	if (s.numberOfCopies > 1) parts.push(`${s.numberOfCopies} copies`);
	if (s.pageSelection) parts.push(`pages ${s.pageSelection}`);
	if (s.pagesPerSheet > 1) parts.push(`${s.pagesPerSheet} pages per sheet`);
	if (s.orientation === "landscape") parts.push("Landscape");
	return `${code(file.name)}: ${parts.join(", ")}`;
}

module.exports = {
	DEFAULT_SETTINGS,
	SETTINGS,
	code,
	num,
	settingByKey,
	menuItems,
	parsePages,
	fileDetails,
	settingsMenu,
	settingPrompt,
	parseSettingAnswer,
	filePrompt,
	fileSummary,
};
