function ListColumn({ title, count, action, onBack, bodyClassName = "", children }) {
	return (
		<div className="db-list">
			<div className="db-list__header">
				{onBack && (
					<button type="button" className="db-list__back" onClick={onBack}>
						<span className="db-list__back-arrow">←</span>
						Settings
					</button>
				)}
				<div className="db-list__title-row">
					<h2 className="db-list__title">{title}</h2>
					{count != null && <span className="db-list__count">{count}</span>}
					{action && <div className="db-list__action">{action}</div>}
				</div>
			</div>
			<div className={`db-list__entries ${bodyClassName}`}>{children}</div>
		</div>
	);
}

export default ListColumn;
