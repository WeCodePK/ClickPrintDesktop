// Document names come from the backend's File model, populated as
// `files[].file = { _id, name, numberOfPages }`.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const backendJob = {
	_id: "j1",
	status: "queued",
	createdAt: new Date().toISOString(),
	files: [
		{ file: { _id: "f1", name: "Thesis final.pdf", numberOfPages: 12 }, settings: { pageType: "A4" } },
		{ file: { _id: "f2", numberOfPages: 1 }, settings: { pageType: "A4" } }, // unnamed
	],
};

test("the job details show each document's real name", async () => {
	const { transformJob } = await import("../renderer/src/dashboard/jobUtils.js");
	const job = transformJob(backendJob);
	assert.deepEqual(job.files.map((f) => f.name), ["Thesis final.pdf", "Document 2"]);
});

test("a single-document job is listed under that document's name", async () => {
	const { transformJob } = await import("../renderer/src/dashboard/jobUtils.js");
	assert.equal(transformJob({ ...backendJob, files: [backendJob.files[0]] }).fileName, "Thesis final.pdf");
});
