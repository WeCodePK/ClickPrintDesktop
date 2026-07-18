import { useState } from "react";

// Shown after OTP verification when the authenticated user owns more than one
// shop. Picking a shop is what actually scopes the session (jobs stream, shop
// settings, etc.) to that shop — App auto-skips this screen for single-shop users.
function ShopSelectScreen({ shops, onSelected, onCancel }) {
	const [selectingId, setSelectingId] = useState(null);
	const [error, setError] = useState("");

	const handleSelect = async (shop) => {
		if (selectingId) return;
		setError("");
		setSelectingId(shop._id);
		try {
			const result = await window.electronAPI.selectShop(shop);
			if (result?.success) {
				onSelected(shop);
			} else {
				setError(result?.message || "Couldn't select that shop. Please try again.");
				setSelectingId(null);
			}
		} catch (err) {
			setError("An unexpected error occurred. Please try again.");
			setSelectingId(null);
		}
	};

	return (
		<div className="screen">
			<button className="back-btn" onClick={onCancel} id="shop-select-back-btn">
				<span className="back-btn__icon">←</span>
				Back
			</button>

			<h1 className="screen__heading">Choose a shop</h1>
			<p className="screen__subheading">
				Your number is linked to more than one shop. Pick the one you want to manage.
			</p>

			<div className="shop-list">
				{shops.map((shop) => {
					const busy = selectingId === shop._id;
					return (
						<button
							key={shop._id}
							className="shop-option"
							onClick={() => handleSelect(shop)}
							disabled={!!selectingId}
							id={`shop-option-${shop._id}`}
						>
							<span className="shop-option__avatar">
								{(shop.name || "?").trim().charAt(0).toUpperCase()}
							</span>
							<span className="shop-option__name">{shop.name || "Unnamed shop"}</span>
							{busy ? (
								<span className="spinner spinner--dark" />
							) : (
								<span className="shop-option__arrow">→</span>
							)}
						</button>
					);
				})}
			</div>

			{error && (
				<p
					style={{
						fontSize: "13px",
						color: "var(--color-accent)",
						marginTop: "8px",
						paddingLeft: "4px",
						animation: "fadeSlideIn 200ms ease",
					}}
				>
					{error}
				</p>
			)}
		</div>
	);
}

export default ShopSelectScreen;
