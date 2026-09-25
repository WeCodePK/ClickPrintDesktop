const { test } = require("node:test");
const assert = require("node:assert/strict");
const { manualPrintReasons, requiresManualPrinting } = require("../main/jobRules");

test("an ordinary job is left to automated printing", () => {
	assert.equal(requiresManualPrinting({ _id: "j" }), false);
	assert.deepEqual(manualPrintReasons({ _id: "j" }), []);
});

test("the backend's default empty additionalComments does not count", () => {
	assert.equal(requiresManualPrinting({ additionalComments: "" }), false);
});

test("whitespace-only additionalComments does not count", () => {
	assert.equal(requiresManualPrinting({ additionalComments: "  \n\t " }), false);
});

test("additionalComments with text requires manual printing", () => {
	assert.deepEqual(manualPrintReasons({ additionalComments: "Staple each copy" }), ["additional-comments"]);
});

test("no paymentProofFile key, or an empty one, does not count", () => {
	assert.equal(requiresManualPrinting({ additionalComments: "" }), false);
	assert.equal(requiresManualPrinting({ paymentProofFile: "" }), false);
});

test("a payment proof requires manual printing, however it is shaped", () => {
	// Populated by the jobs endpoint.
	assert.deepEqual(manualPrintReasons({ paymentProofFile: { _id: "f1", name: "shot.png" } }), ["payment-proof"]);
	// Bare id.
	assert.deepEqual(manualPrintReasons({ paymentProofFile: "f1" }), ["payment-proof"]);
	// Attached, but its file record no longer resolves (populate yields null).
	assert.deepEqual(manualPrintReasons({ paymentProofFile: null }), ["payment-proof"]);
});

test("both fields report both reasons", () => {
	assert.deepEqual(
		manualPrintReasons({ additionalComments: "Urgent", paymentProofFile: { _id: "f1" } }),
		["additional-comments", "payment-proof"]
	);
});

test("a missing job is not flagged", () => {
	assert.equal(requiresManualPrinting(undefined), false);
	assert.equal(requiresManualPrinting(null), false);
});
