// The backend's 4-digit job code — the short id customers and the shop use to
// identify a job — as the renderer carries and displays it.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const job = (extra) => ({ _id: "j1", status: "queued", createdAt: new Date().toISOString(), files: [], ...extra });

test("the code is displayed with a leading #, keeping leading zeros", async () => {
	const { transformJob, formatJobCode } = await import("../renderer/src/dashboard/jobUtils.js");
	assert.equal(formatJobCode(transformJob(job({ code: "0427" })).code), "#0427");
	assert.equal(formatJobCode(transformJob(job({ code: 5310 })).code), "#5310");
});

test("a job without a code shows none", async () => {
	const { transformJob, formatJobCode } = await import("../renderer/src/dashboard/jobUtils.js");
	assert.equal(transformJob(job()).code, null);
	assert.equal(formatJobCode(transformJob(job({ code: "" })).code), null);
});

test("dialogs refer to a job by its code, or as \"this job\" without one", async () => {
	const { transformJob, jobLabel } = await import("../renderer/src/dashboard/jobUtils.js");
	assert.equal(jobLabel(transformJob(job({ code: "0427" }))), "job #0427");
	assert.equal(jobLabel({ fileName: "notes.pdf" }), "this job");
});
