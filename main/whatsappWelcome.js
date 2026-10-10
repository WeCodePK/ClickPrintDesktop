const { T, detectLanguage } = require("./whatsappChatFlow");

// Shared welcome wording. AI chat checks the first incoming message's type in
// whatsappChatHelp; the numbered menu welcomes on its first text. Record the
// welcome after the reply is sent or queued for delivery.
function createWelcome(core, api, getShopName = () => null) {
	async function message(shopId, customer, text, assistant = "AI") {
		if (core.hasGreeted(core.keyOf(shopId, customer.number), assistant)) return null;
		let name = getShopName(shopId);
		if (!name) {
			try {
				const shop = await api.fetchShop();
				if (shop?.success) name = shop.data?.name;
			} catch (error) {
				console.error("[WA] could not load welcome shop name:", error.message);
			}
		}
		return (T[detectLanguage(text)] || T.en).welcome(name || "this shop", assistant);
	}

	function sent(shopId, customer, assistant = "AI") {
		core.markGreeted(core.keyOf(shopId, customer.number), assistant);
	}

	return { message, sent };
}

module.exports = { createWelcome };
