import React from "react";

// Middle column shell shared by every tab: the header (title + optional count /
// action) and the scrollable entries area. Each tab supplies its own entry rows.
function ListColumn({ title, count, action, children }) {
	return (
		<div className="db-list">
			<div className="db-list__header">
				<div className="db-list__title-row">
					<h2 className="db-list__title">{title}</h2>
					{count != null && <span className="db-list__count">{count}</span>}
					{action && <div className="db-list__action">{action}</div>}
				</div>
			</div>
			<div className="db-list__entries">{children}</div>
		</div>
	);
}

export default ListColumn;
