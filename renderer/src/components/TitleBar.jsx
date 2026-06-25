import React from "react";

function TitleBar({ theme, onToggleTheme }) {
	const handleMinimize = () => window.electronAPI?.minimizeWindow();
	const handleMaximize = () => window.electronAPI?.maximizeWindow();
	const handleClose = () => window.electronAPI?.closeWindow();

	return (
		<div className="title-bar">
			<div className="title-bar__brand">
				<img src="icon.png" className="title-bar__logo" alt="" />
				<span className="title-bar__title">
					<span className="title-bar__title-click">Click</span>
					<span className="title-bar__title-print">Print</span>
				</span>
			</div>
			<div className="title-bar__controls">
				<button
					className="title-bar__theme-toggle"
					onClick={onToggleTheme}
					aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
				>
					{theme === "dark" ? (
						<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
							<circle cx="12" cy="12" r="5" />
							<line x1="12" y1="1" x2="12" y2="3" />
							<line x1="12" y1="21" x2="12" y2="23" />
							<line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
							<line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
							<line x1="1" y1="12" x2="3" y2="12" />
							<line x1="21" y1="12" x2="23" y2="12" />
							<line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
							<line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
						</svg>
					) : (
						<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
							<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
						</svg>
					)}
				</button>
				<span className="title-bar__sep" aria-hidden="true" />
				<button
					className="title-bar__btn title-bar__btn--minimize"
					onClick={handleMinimize}
					aria-label="Minimize"
				>
					<svg viewBox="0 0 10 10">
						<line x1="1.5" y1="5" x2="8.5" y2="5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
					</svg>
				</button>
				<button
					className="title-bar__btn title-bar__btn--maximize"
					onClick={handleMaximize}
					aria-label="Maximize"
				>
					<svg viewBox="0 0 10 10">
						<rect x="2" y="2" width="6" height="6" rx="0.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
					</svg>
				</button>
				<button
					className="title-bar__btn title-bar__btn--close"
					onClick={handleClose}
					aria-label="Close"
				>
					<svg viewBox="0 0 10 10">
						<path d="M2.5,2.5 L7.5,7.5 M7.5,2.5 L2.5,7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
					</svg>
				</button>
			</div>
		</div>
	);
}

export default TitleBar;