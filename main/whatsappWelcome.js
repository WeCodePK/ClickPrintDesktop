const { T, detectLanguage } = require("./whatsappChatFlow");

// Shared by both ordering styles. Documents do not consume the welcome, and
// the incoming handler records it only after the message was actually sent.
function createWelcome(core, api, getShopName = () => null) {
	async function message(shopId, customer, text) {
		if (core.hasGreeted(core.keyOf(shopId, customer.number))) return null;
		let name = getShopName(shopId);
		if (!name) {
			try {
				const shop = await api.fetchShop();
				if (shop?.success) name = shop.data?.name;
			} catch (error) {
				console.error("[WA] could not load welcome shop name:", error.message);
			}
		}
		return (T[detectLanguage(text)] || T.en).welcome(name || "this shop");
	}

	function sent(shopId, customer) {
		core.markGreeted(core.keyOf(shopId, customer.number));
	}

	return { message, sent };
}

module.exports = { createWelcome };
