import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import StepLayout from "./StepLayout";
import ConfirmDialog from "../dashboard/components/ConfirmDialog";
import ServiceForm, { serviceLabel, sameKeys, printerIdOf, loadServicePrinters } from "../dashboard/components/ServiceForm";
import { WalletIcon, EditIcon, TrashIcon, BoltIcon } from "../dashboard/icons";

// Step 2: create at least one service, with the same form the Services tab uses.
function ServicesStep({ onNext, ...layout }) {
	const [services, setServices] = useState([]);
	const [printers, setPrinters] = useState([]);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState(null);
	const [editing, setEditing] = useState(null); // service, { keys: {} } for new, or null
	const [saving, setSaving] = useState(false);
	const [formError, setFormError] = useState(null);
	const [confirmDelete, setConfirmDelete] = useState(null);
	const [pendingOverwrite, setPendingOverwrite] = useState(null);

	const loadServices = useCallback(async () => {
		const result = await window.electronAPI.fetchServices();
		if (!result?.success) throw new Error(result?.message || "Couldn't load services.");
		setServices(result.data || []);
	}, []);

	const load = useCallback(async () => {
		setLoading(true);
		setLoadError(null);
		try {
			const [, list] = await Promise.all([loadServices(), loadServicePrinters()]);
			if (!list) throw new Error("Couldn't load this shop's printers.");
			setPrinters(list);
		} catch (err) {
			console.error("[Onboarding] failed to load services:", err);
			setLoadError(err.message);
		} finally {
			setLoading(false);
		}
	}, [loadServices]);

	useEffect(() => {
		load();
	}, [load]);

	const openForm = (service) => {
		setFormError(null);
		setEditing(service);
	};

	const persist = async (id, data) => {
		setSaving(true);
		setFormError(null);
		try {
			const result = id
				? await window.electronAPI.updateService(id, data)
				: await window.electronAPI.createService(data);
			if (!result?.success) {
				setFormError(result?.message || "Failed to save service.");
				return;
			}
			await loadServices();
			window.electronAPI.refreshRouting();
			setEditing(null);
		} catch (err) {
			console.error("[Onboarding] failed to save service:", err);
			setFormError("Failed to save service.");
		} finally {
			setSaving(false);
		}
	};

	const handleSave = (data) => {
		if (!editing._id) {
			const existing = services.find((s) => sameKeys(s.keys, data.keys));
			if (existing) {
				setPendingOverwrite({ existing, data });
				return;
			}
		}
		persist(editing._id, data);
	};

	const handleConfirmOverwrite = () => {
		const { existing, data } = pendingOverwrite;
		setPendingOverwrite(null);
		persist(existing._id, data);
	};

	const handleDelete = async (service) => {
		setConfirmDelete(null);
		try {
			const result = await window.electronAPI.deleteService(service._id);
			if (!result?.success) throw new Error(result?.message || "Failed to delete service.");
			await loadServices();
			window.electronAPI.refreshRouting();
		} catch (err) {
			console.error("[Onboarding] failed to delete service:", err);
			setLoadError(err.message);
		}
	};

	const printerLabel = (entry) => printers.find((p) => p._id === printerIdOf(entry))?.label || "Unknown printer";
	const canContinue = services.length > 0;

	return (
		<StepLayout
			{...layout}
			onNext={onNext}
			nextDisabled={loading || !canContinue}
			hint={!loading && !canContinue ? "Add at least one service to continue" : null}
		>
			{loadError && <div className="form-error onb-error">{loadError}</div>}

			<div className="onb-toolbar">
				<span className="onb-toolbar__summary">
					{services.length
						? `${services.length} service${services.length === 1 ? "" : "s"} created`
						: "No services yet"}
				</span>
				{services.length > 0 && (
					<button type="button" className="onb-link-btn" onClick={() => openForm({ keys: {} })} disabled={loading}>
						+ Add another service
					</button>
				)}
			</div>

			{loading ? (
				<div className="onb-loading">
					<div className="spinner spinner--dark" />
					<p>Loading services…</p>
				</div>
			) : services.length === 0 ? (
				<div className="onb-empty">
					<span className="onb-empty__icon"><WalletIcon /></span>
					<p className="onb-empty__title">Create your first service</p>
					<p className="onb-empty__text">
						For example “A4, Black &amp; White, Single Sided” at Rs. 10 per page, printed on your laser printer.
					</p>
					<button type="button" className="btn-gradient onb-empty__cta" onClick={() => openForm({ keys: {} })}>
						+ Add service
					</button>
				</div>
			) : (
				<div className="onb-grid">
					{services.map((service, i) => (
						<div
							key={service._id}
							className={`onb-card onb-card--static ${service.isDisabled ? "onb-card--muted" : ""}`}
							style={{ animationDelay: `${i * 55}ms` }}
						>
							<span className="onb-card__icon"><WalletIcon /></span>
							<span className="onb-card__info">
								<span className="onb-card__name">{service.name || serviceLabel(service.keys)}</span>
								<span className="onb-card__meta">
									Rs. {service.rate} / page
									{service.isDisabled ? " · Disabled" : ""}
								</span>
								<span className="onb-card__chips">
									{(service.printers || []).map((entry, j) => (
										<span className="onb-chip" key={printerIdOf(entry) || j}>
											{entry.useAuto && <BoltIcon />}
											{printerLabel(entry)}
										</span>
									))}
								</span>
							</span>
							<span className="onb-card__actions">
								<button type="button" className="onb-icon-btn" onClick={() => openForm(service)} title="Edit service">
									<EditIcon />
								</button>
								<button
									type="button"
									className="onb-icon-btn onb-icon-btn--danger"
									onClick={() => setConfirmDelete(service)}
									title="Delete service"
								>
									<TrashIcon />
								</button>
							</span>
						</div>
					))}
				</div>
			)}

			{editing &&
				createPortal(
					<div className="modal-overlay" onClick={() => !saving && setEditing(null)}>
						<div className="modal-card modal-card--wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
							<ServiceForm
								key={editing._id || "new"}
								service={editing}
								printers={printers}
								error={formError}
								saving={saving}
								onSave={handleSave}
								onCancel={() => setEditing(null)}
							/>
						</div>
					</div>,
					document.body
				)}

			{confirmDelete &&
				createPortal(
					<ConfirmDialog
						title="Delete this service?"
						message={`Are you sure you want to delete "${confirmDelete.name || serviceLabel(confirmDelete.keys)}"? This cannot be undone.`}
						confirmLabel="Delete"
						cancelLabel="Cancel"
						danger
						onConfirm={() => handleDelete(confirmDelete)}
						onCancel={() => setConfirmDelete(null)}
					/>,
					document.body
				)}

			{pendingOverwrite &&
				createPortal(
					<ConfirmDialog
						title="Overwrite Service"
						message={`A service for "${pendingOverwrite.existing.name || serviceLabel(pendingOverwrite.existing.keys)}" already exists. Overwrite the existing service with this new rate?`}
						confirmLabel="Overwrite Service"
						cancelLabel="Cancel"
						onConfirm={handleConfirmOverwrite}
						onCancel={() => setPendingOverwrite(null)}
					/>,
					document.body
				)}
		</StepLayout>
	);
}

export default ServicesStep;
