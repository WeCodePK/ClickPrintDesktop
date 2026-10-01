// The single bottom-right column every toast is portalled into, so the
// persistent notices (update, connection) and the dismissible engine toasts
// stack instead of overlapping. Persistent ones sit at the bottom (CSS `order`).
export function toastDock() {
	let el = document.getElementById("toast-dock");
	if (!el) {
		el = document.createElement("div");
		el.id = "toast-dock";
		el.className = "toast-dock";
		document.body.appendChild(el);
	}
	return el;
}
