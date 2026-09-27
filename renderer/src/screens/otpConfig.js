// The backend says how long the code is and how long to wait before offering a
// resend ({ codeLength, resendInMs } on the /api/auth/otp response). These
// defaults only apply if a response doesn't carry a usable config.
const DEFAULT_CODE_LENGTH = 5;
const DEFAULT_RESEND_SECONDS = 60;

export function readOtpConfig(config) {
	// null/"" would otherwise read as 0 — treat them as missing.
	const length = config?.codeLength == null || config.codeLength === "" ? NaN : Number(config.codeLength);
	const resendMs = config?.resendInMs == null || config.resendInMs === "" ? NaN : Number(config.resendInMs);
	return {
		codeLength: Number.isInteger(length) && length >= 4 && length <= 8 ? length : DEFAULT_CODE_LENGTH,
		resendSeconds: Number.isFinite(resendMs) && resendMs >= 0 ? Math.ceil(resendMs / 1000) : DEFAULT_RESEND_SECONDS,
	};
}
