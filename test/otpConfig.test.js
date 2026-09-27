// The OTP screen follows the backend's { codeLength, resendInMs } from
// POST /api/auth/otp, falling back to 5 digits / 60 s only when it's unusable.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../renderer/src/screens/otpConfig.js");

test("the backend's code length and resend wait are used", async () => {
	const { readOtpConfig } = await load();
	assert.deepEqual(readOtpConfig({ codeLength: 5, resendInMs: 30000 }), { codeLength: 5, resendSeconds: 30 });
	assert.deepEqual(readOtpConfig({ codeLength: 6, resendInMs: 45500 }), { codeLength: 6, resendSeconds: 46 });
	assert.deepEqual(readOtpConfig({ codeLength: "4", resendInMs: 0 }), { codeLength: 4, resendSeconds: 0 });
});

test("a missing or unusable config falls back to the defaults", async () => {
	const { readOtpConfig } = await load();
	const defaults = { codeLength: 5, resendSeconds: 60 };
	assert.deepEqual(readOtpConfig(undefined), defaults);
	assert.deepEqual(readOtpConfig({}), defaults);
	assert.deepEqual(readOtpConfig({ codeLength: 20, resendInMs: -1 }), defaults);
	assert.deepEqual(readOtpConfig({ codeLength: 5.5, resendInMs: "soon" }), defaults);
	assert.deepEqual(readOtpConfig({ codeLength: null, resendInMs: null }), defaults);
});
