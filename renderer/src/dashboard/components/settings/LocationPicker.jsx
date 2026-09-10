import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Islamabad default coordinates
const DEFAULT_CENTER = [33.6844, 73.0479];
const DEFAULT_ZOOM = 12;
const PICKED_ZOOM = 16;

const round = (n) => Number(n.toFixed(5));

export function LocationPicker({ value, onChange }) {
	const containerRef = useRef(null);
	const mapRef = useRef(null);
	const markerRef = useRef(null);
	const placeRef = useRef(null);
	const onChangeRef = useRef(onChange);

	// Search state (Addition 1)
	const [searchQuery, setSearchQuery] = useState("");
	const [searching, setSearching] = useState(false);
	const [searchResults, setSearchResults] = useState([]);
	const [searchError, setSearchError] = useState(null);
	const [showDropdown, setShowDropdown] = useState(false);
	const searchContainerRef = useRef(null);

	useEffect(() => {
		onChangeRef.current = onChange;
	}, [onChange]);

	useEffect(() => {
		if (!containerRef.current || mapRef.current) return;

		const start = value;
		const map = L.map(containerRef.current, {
			center: start ? [start.lat, start.lng] : DEFAULT_CENTER,
			zoom: start ? PICKED_ZOOM : DEFAULT_ZOOM,
		});
		mapRef.current = map;

		L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
			maxZoom: 19,
			attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
		}).addTo(map);

		// Custom SVG pin marker matching ClickPrint accent style
		const icon = L.divIcon({
			className: "custom-map-pin",
			html: `<div style="
				width: 24px;
				height: 24px;
				border-radius: 50%;
				background: #ff4f00;
				border: 3px solid #ffffff;
				box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
				display: flex;
				align-items: center;
				justify-content: center;
			">
				<div style="width: 6px; height: 6px; border-radius: 50%; background: #ffffff;"></div>
			</div>`,
			iconSize: [24, 24],
			iconAnchor: [12, 12],
		});

		placeRef.current = (lat, lng) => {
			if (markerRef.current) {
				markerRef.current.setLatLng([lat, lng]);
				return;
			}
			markerRef.current = L.marker([lat, lng], { icon, draggable: true })
				.addTo(map)
				.on("dragend", (event) => {
					const { lat: dLat, lng: dLng } = event.target.getLatLng();
					onChangeRef.current({ lat: round(dLat), lng: round(dLng) });
				});
		};

		if (start) {
			placeRef.current(start.lat, start.lng);
		}

		map.on("click", (event) => {
			const { lat, lng } = event.latlng;
			placeRef.current?.(lat, lng);
			onChangeRef.current({ lat: round(lat), lng: round(lng) });
		});

		// Ensure map renders properly after DOM mount and layout animations
		const timers = [
			setTimeout(() => map.invalidateSize(), 50),
			setTimeout(() => map.invalidateSize(), 200),
			setTimeout(() => map.invalidateSize(), 500),
		];

		const resizeObserver = new ResizeObserver(() => {
			if (mapRef.current) {
				mapRef.current.invalidateSize();
			}
		});
		if (containerRef.current) {
			resizeObserver.observe(containerRef.current);
		}

		return () => {
			timers.forEach(clearTimeout);
			resizeObserver.disconnect();
			map.remove();
			mapRef.current = null;
			markerRef.current = null;
			placeRef.current = null;
		};
	}, []);

	// Sync external value changes to map marker
	useEffect(() => {
		if (!value || !placeRef.current || !mapRef.current) return;
		const current = markerRef.current?.getLatLng();
		if (current && round(current.lat) === value.lat && round(current.lng) === value.lng) {
			return;
		}
		placeRef.current(value.lat, value.lng);
		mapRef.current.panTo([value.lat, value.lng]);
	}, [value]);

	// Handle outside clicks to close search dropdown
	useEffect(() => {
		function handleClickOutside(e) {
			if (searchContainerRef.current && !searchContainerRef.current.contains(e.target)) {
				setShowDropdown(false);
			}
		}
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, []);

	const searchRequestIdRef = useRef(0);
	const isSelectingRef = useRef(false);

	// Search execution with race condition prevention
	const executeSearch = async (queryText) => {
		const query = (queryText !== undefined ? queryText : searchQuery).trim();
		if (!query) {
			setSearchResults([]);
			setShowDropdown(false);
			setSearching(false);
			return;
		}

		const requestId = ++searchRequestIdRef.current;
		setSearching(true);
		setSearchError(null);
		setShowDropdown(true);

		try {
			const result = await window.electronAPI?.searchLocation?.(query);
			if (requestId !== searchRequestIdRef.current) return; // Ignore outdated responses

			if (result?.success && Array.isArray(result.data)) {
				setSearchResults(result.data);
				if (result.data.length === 0) {
					setSearchError("No locations found. Try a different query.");
				}
			} else {
				setSearchResults([]);
				setSearchError(result?.message || "Search failed. Please try again.");
			}
		} catch (err) {
			if (requestId !== searchRequestIdRef.current) return;
			console.error("[LocationPicker] search error:", err);
			setSearchResults([]);
			setSearchError("Error searching location.");
		} finally {
			if (requestId === searchRequestIdRef.current) {
				setSearching(false);
			}
		}
	};

	// Debounced type-ahead search as the user types
	useEffect(() => {
		if (isSelectingRef.current) {
			isSelectingRef.current = false;
			return;
		}

		const trimmed = searchQuery.trim();
		if (!trimmed || trimmed.length < 2) {
			setSearchResults([]);
			setShowDropdown(false);
			setSearching(false);
			return;
		}

		const debounceTimer = setTimeout(() => {
			executeSearch(trimmed);
		}, 300);

		return () => clearTimeout(debounceTimer);
	}, [searchQuery]);

	const handleSearch = (e) => {
		if (e) e.preventDefault();
		executeSearch(searchQuery);
	};

	const handleSelectLocation = (item) => {
		isSelectingRef.current = true;
		const lat = round(parseFloat(item.lat));
		const lng = round(parseFloat(item.lon));
		if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

		setShowDropdown(false);
		setSearchResults([]);
		setSearchQuery(item.display_name?.split(",")?.[0]?.trim() || item.display_name || "");

		placeRef.current?.(lat, lng);
		mapRef.current?.setView([lat, lng], PICKED_ZOOM, { animate: true });
		onChangeRef.current({ lat, lng });
	};

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: "8px", width: "100%" }}>
			{/* Location Search Bar (Addition 1) */}
			<div ref={searchContainerRef} style={{ position: "relative", width: "100%" }}>
				<div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
					<div style={{ position: "relative", flex: 1 }}>
						<input
							type="text"
							className="form-input"
							placeholder="Search for places or addresses (e.g. F-7 Markaz, Islamabad)..."
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									handleSearch();
								}
							}}
							style={{
								paddingRight: searchQuery ? "32px" : "12px",
								fontSize: "13px",
							}}
						/>
						{searchQuery && (
							<button
								type="button"
								onClick={() => {
									setSearchQuery("");
									setSearchResults([]);
									setShowDropdown(false);
								}}
								style={{
									position: "absolute",
									right: "10px",
									top: "50%",
									transform: "translateY(-50%)",
									background: "none",
									border: "none",
									color: "var(--color-text-muted)",
									cursor: "pointer",
									fontSize: "14px",
									padding: "2px",
									lineHeight: 1,
								}}
								title="Clear search"
							>
								✕
							</button>
						)}
					</div>
					<button
						type="button"
						onClick={handleSearch}
						disabled={searching || !searchQuery.trim()}
						className="btn-gradient"
						style={{
							padding: "9px 16px",
							fontSize: "13px",
							borderRadius: "var(--radius-md)",
							whiteSpace: "nowrap",
							cursor: searching || !searchQuery.trim() ? "not-allowed" : "pointer",
							opacity: searching || !searchQuery.trim() ? 0.6 : 1,
						}}
					>
						{searching ? "Searching…" : "Search"}
					</button>
				</div>

				{/* Search Results Dropdown */}
				{showDropdown && (
					<div
						style={{
							position: "absolute",
							top: "calc(100% + 4px)",
							left: 0,
							right: 0,
							zIndex: 1000,
							background: "var(--color-bg-card)",
							border: "1px solid var(--border-light)",
							borderRadius: "var(--radius-md)",
							boxShadow: "var(--shadow-lg)",
							maxHeight: "220px",
							overflowY: "auto",
							padding: "4px 0",
						}}
					>
						{searching && (
							<div style={{ padding: "12px 16px", fontSize: "12.5px", color: "var(--color-text-muted)" }}>
								Searching OpenStreetMap…
							</div>
						)}
						{!searching && searchError && (
							<div style={{ padding: "12px 16px", fontSize: "12.5px", color: "var(--color-accent)" }}>
								{searchError}
							</div>
						)}
						{!searching &&
							searchResults.map((item, idx) => (
								<div
									key={item.place_id || idx}
									onClick={() => handleSelectLocation(item)}
									style={{
										padding: "10px 14px",
										cursor: "pointer",
										borderBottom: idx < searchResults.length - 1 ? "1px solid var(--border-light)" : "none",
										transition: "background var(--transition-fast)",
									}}
									onMouseEnter={(e) => {
										e.currentTarget.style.backgroundColor = "var(--color-bg-input)";
									}}
									onMouseLeave={(e) => {
										e.currentTarget.style.backgroundColor = "transparent";
									}}
								>
									<div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)" }}>
										{item.display_name?.split(",")?.[0] || item.name || "Location"}
									</div>
									<div
										style={{
											fontSize: "11.5px",
											color: "var(--color-text-muted)",
											marginTop: "2px",
											whiteSpace: "nowrap",
											overflow: "hidden",
											textOverflow: "ellipsis",
										}}
									>
										{item.display_name}
									</div>
								</div>
							))}
					</div>
				)}
			</div>

			{/* Map Container */}
			<div
				ref={containerRef}
				style={{
					height: "280px",
					width: "100%",
					borderRadius: "var(--radius-md)",
					border: "1px solid var(--border-light)",
					overflow: "hidden",
					zIndex: 1,
				}}
			/>
		</div>
	);
}

export default LocationPicker;
