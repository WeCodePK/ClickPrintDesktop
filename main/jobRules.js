// Jobs the customer annotated — free-text additional comments, or a payment
// proof screenshot — need a person to read them before anything prints, so
// automated printing never picks them up. The operator still prints them by
// hand. Takes a raw backend job.

// Every job carries `additionalComments` (the backend defaults it to ""), so only
// non-blank text counts.
function hasAdditionalComments(job) {
	const comments = job?.additionalComments;
	return comments != null && String(comments).trim() !== "";
}

// Absent when none was attached. A populated `{ _id, name }` or a bare id means
// one was; `null` means one was attached but its file record no longer resolves,
// which is still a customer claiming payment — still a job for a human.
function hasPaymentProof(job) {
	const proof = job?.paymentProofFile;
	return proof !== undefined && proof !== "";
}

function manualPrintReasons(job) {
	const reasons = [];
	if (hasAdditionalComments(job)) reasons.push("additional-comments");
	if (hasPaymentProof(job)) reasons.push("payment-proof");
	return reasons;
}

function requiresManualPrinting(job) {
	return manualPrintReasons(job).length > 0;
}

module.exports = { manualPrintReasons, requiresManualPrinting };
