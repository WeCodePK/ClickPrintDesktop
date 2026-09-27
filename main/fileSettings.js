// Operator overrides of a document's print settings. The customer's settings
// arrive with the job; the operator may change any of them before printing
// (a wrong paper size, "print it in colour after all", fewer copies…). An
// override is a partial settings object layered over the customer's — only the
// keys that differ are kept, so setting a value back to what the customer chose
// removes that override. Pure functions; the print engine owns the state.

const SIDEDNESS = new Set(["none", "long", "short"]);
const ORIENTATIONS = new Set(["portrait", "landscape"]);
const PAGES_PER_SHEET = new Set([1, 2, 4, 6, 9, 16]);
const MAX_COPIES = 999;
// "1-3, 5, 8-10" — the same shape files.parsePageRanges understands.
const PAGE_SELECTION_RE = /^\s*\d+\s*(-\s*\d+\s*)?(,\s*\d+\s*(-\s*\d+\s*)?)*$/;

// Validates one operator change. Returns { patch } with only recognised,
// well-formed keys, or { error } naming the first bad value. An empty or "all"
// page selection means every page and is stored as "".
function sanitizeSettingsPatch(patch) {
	if (!patch || typeof patch !== "object") return { error: "no settings given" };
	const out = {};
	for (const [key, value] of Object.entries(patch)) {
		switch (key) {
			case "pageType": {
				const size = String(value ?? "").trim();
				if (!size || size.length > 20) return { error: "invalid paper size" };
				out.pageType = size;
				break;
			}
			case "color":
				if (typeof value !== "boolean") return { error: "invalid colour setting" };
				out.color = value;
				break;
			case "pageSelection": {
				const text = String(value ?? "").trim();
				if (!text || /^all/i.test(text)) {
					out.pageSelection = "";
					break;
				}
				if (!PAGE_SELECTION_RE.test(text)) return { error: 'pages must look like "1-3, 5"' };
				for (const part of text.split(",")) {
					const [from, to] = part.split("-").map((n) => parseInt(n, 10));
					if (from < 1 || (to !== undefined && to < from)) return { error: "invalid page range" };
				}
				out.pageSelection = text.replace(/\s+/g, "").replace(/,/g, ", ");
				break;
			}
			// An explicit flip edge (the Duplex setting) — or "none" for single-sided.
			case "sidedness":
				if (!SIDEDNESS.has(value)) return { error: "invalid sides setting" };
				out.sidedness = value;
				break;
			// The Sides setting: the flip edge for "double" is worked out by
			// applySettingsPatch.
			case "sides":
				if (value !== "single" && value !== "double") return { error: "invalid sides setting" };
				out.sides = value;
				break;
			case "orientation":
				if (!ORIENTATIONS.has(value)) return { error: "invalid orientation" };
				out.orientation = value;
				break;
			case "numberOfCopies": {
				const copies = Number(value);
				if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) {
					return { error: `copies must be 1–${MAX_COPIES}` };
				}
				out.numberOfCopies = copies;
				break;
			}
			case "pagesPerSheet": {
				const perSheet = Number(value);
				if (!PAGES_PER_SHEET.has(perSheet)) return { error: "invalid pages per sheet" };
				out.pagesPerSheet = perSheet;
				break;
			}
			default:
				return { error: `unknown setting "${key}"` };
		}
	}
	return { patch: out };
}

// Values as the customer's settings leave them unset: no page selection is all
// pages, no copies is one, no pages-per-sheet is one.
function _normalised(key, value) {
	if (key === "pageSelection") return value || "";
	if (key === "numberOfCopies" || key === "pagesPerSheet") return value || 1;
	if (key === "color") return !!value;
	return value ?? null;
}

// Folds a (sanitised) patch into an existing override, dropping every key that
// now matches the customer's original. Returns null when nothing differs.
function mergeOverride(original = {}, current = {}, patch = {}) {
	const next = { ...current, ...patch };
	for (const key of Object.keys(next)) {
		if (key === DUPLEX_EXPLICIT) continue;
		if (_normalised(key, next[key]) === _normalised(key, original[key])) delete next[key];
	}
	// The flag only means something alongside an overridden flip edge.
	if (!("sidedness" in next)) delete next[DUPLEX_EXPLICIT];
	return Object.keys(next).length ? next : null;
}

// ── Flip edge (duplex) ───────────────────────────────────────────────────────
// The backend sends one `sidedness`: "none" | "long" | "short". When the operator
// turns a single-sided document double-sided, the customer never chose an edge,
// so one is worked out from the orientation — portrait flips on the long edge,
// landscape on the short — and follows later orientation changes. Two things stop
// that: the operator picking the edge themselves (the Duplex setting, recorded as
// DUPLEX_EXPLICIT), or the customer having chosen one, which is always honoured.

// Marks an override whose flip edge the operator chose explicitly. Stored with
// the override; never part of the settings a document prints with.
const DUPLEX_EXPLICIT = "duplexExplicit";

const isDouble = (sidedness) => !!sidedness && sidedness !== "none";
const edgeFor = (orientation) => (orientation === "landscape" ? "short" : "long");

// Applies a sanitised patch to a document's override. Besides plain settings it
// understands `sides` ("single" | "double") and works out the flip edge as
// described above. Returns the next override, or null when nothing differs from
// the customer's settings.
function applySettingsPatch(original = {}, current = null, patch = {}) {
	const { sides, ...rest } = patch;
	const next = { ...(current || {}), ...rest };
	let explicit = !!next[DUPLEX_EXPLICIT];
	const setting = (key) => (key in next ? next[key] : original[key]);

	if ("sidedness" in rest) explicit = isDouble(rest.sidedness);
	if (sides === "single") {
		next.sidedness = "none";
		explicit = false;
	} else if (sides === "double" && !isDouble(setting("sidedness"))) {
		next.sidedness = isDouble(original.sidedness) ? original.sidedness : edgeFor(setting("orientation"));
	}
	// A worked-out edge follows the orientation.
	if ("orientation" in rest && !explicit && !isDouble(original.sidedness) && isDouble(setting("sidedness"))) {
		next.sidedness = edgeFor(setting("orientation"));
	}

	if (explicit) next[DUPLEX_EXPLICIT] = true;
	else delete next[DUPLEX_EXPLICIT];
	return mergeOverride(original, {}, next);
}

// The settings a document actually prints with.
function effectiveSettings(original = {}, override = null) {
	if (!override) return original;
	const { [DUPLEX_EXPLICIT]: _explicit, ...settings } = override;
	return { ...original, ...settings };
}

module.exports = {
	sanitizeSettingsPatch,
	applySettingsPatch,
	mergeOverride,
	effectiveSettings,
	DUPLEX_EXPLICIT,
	PAGES_PER_SHEET,
	MAX_COPIES,
};
