// ── Static / placeholder data ─────────────────────────────────────────────────
// These remain hard-coded until the corresponding backend endpoints exist.

export const DUMMY_PRINTERS = [
	{
		_id: "p1",
		name: "Receipt Thermal XP-80",
		status: "online",
		type: "Thermal Receipt",
		ipAddress: "192.168.1.150",
		toner: 94,
		paperSize: "80mm Roll",
		location: "Main Counter",
	},
	{
		_id: "p2",
		name: "HP LaserJet Pro M404dn",
		status: "online",
		type: "Laser B&W",
		ipAddress: "192.168.1.155",
		toner: 42,
		paperSize: "A4 / Letter",
		location: "Back Office Office",
	},
	{
		_id: "p3",
		name: "Epson L3250 EcoTank",
		status: "offline",
		type: "Inkjet Color",
		ipAddress: "192.168.1.160",
		toner: 80,
		paperSize: "A4 / A5 / Photo",
		location: "Print Desk 1",
	},
];
