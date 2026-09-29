const path = require("path");
const { code } = require("./whatsappSettings");

// Pure helpers for documents customers send over WhatsApp: finding the document
// in a Baileys message, naming it the way the backend's tus upload accepts, and
// turning an upload failure into a reply the customer can act on. No Electron or
// Baileys imports, so these run under plain `node --test`.

// The backend refuses anything larger (413).
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// The backend picks its converter from the filename's extension, so a name
// without one fails conversion — fill it in from the type WhatsApp reports.
const EXTENSIONS = {
	"application/pdf": "pdf",
	"application/msword": "doc",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
	"application/vnd.ms-powerpoint": "ppt",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
	"application/vnd.ms-excel": "xls",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
	"application/vnd.oasis.opendocument.text": "odt",
	"application/vnd.oasis.opendocument.spreadsheet": "ods",
	"application/vnd.oasis.opendocument.presentation": "odp",
	"application/rtf": "rtf",
	"text/rtf": "rtf",
	"text/plain": "txt",
	"text/csv": "csv",
	"text/html": "html",
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/gif": "gif",
	"image/bmp": "bmp",
	"image/tiff": "tiff",
	"image/svg+xml": "svg",
};

const MAX_NAME_LENGTH = 255;

// The documentMessage inside a Baileys message, or null. A document sent with a
// caption arrives wrapped in documentWithCaptionMessage.
function documentOf(msg) {
	const content = msg?.message;
	return content?.documentMessage ?? content?.documentWithCaptionMessage?.message?.documentMessage ?? null;
}

// fileLength arrives as a protobuf Long, a number, or (after JSON) a string.
function documentSize(doc) {
	const length = doc?.fileLength;
	if (length == null) return null;
	const size = typeof length.toNumber === "function" ? length.toNumber() : Number(length);
	return Number.isFinite(size) ? size : null;
}

// A filename the backend accepts: none of / \ < > : " | ? * or control
// characters, no trailing dot or space, at most 255 characters, and ending in an
// extension.
function uploadName(fileName, mimetype) {
	let name = String(fileName || "")
		.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
		.replace(/[. ]+$/, "")
		.trim();
	let ext = path.extname(name);
	if (!ext || ext === name) {
		ext = `.${EXTENSIONS[String(mimetype || "").split(";")[0].trim().toLowerCase()] || "pdf"}`;
		name = `${name || "document"}${ext}`;
	}
	if (name.length > MAX_NAME_LENGTH) {
		name = `${name.slice(0, MAX_NAME_LENGTH - ext.length).replace(/[. ]+$/, "")}${ext}`;
	}
	return name;
}

// The reply sent to the customer when their document couldn't be uploaded.
// `status` is the backend's HTTP status (absent for network failures);
// `message` is the backend's own message, used for statuses we don't know.
function uploadErrorReply(fileName, { status, message } = {}) {
	const name = fileName ? code(fileName) : "your file";
	switch (status) {
		case 400:
			return `Sorry, we couldn't accept ${name} because of its file name. Please rename it (without / \\ < > : " | ? *) and send it again.`;
		case 404:
			return `Sorry, the upload of ${name} was interrupted. Please send it again.`;
		case 413:
			return `Sorry, ${name} is too large. Files can be at most 100 MB.`;
		case 422:
			return `Sorry, we couldn't open ${name}. Please send it as a PDF, Word, Excel, PowerPoint, or JPG/PNG image.`;
		case 401:
		case 412:
		case undefined:
		case null:
			return `Sorry, we couldn't receive ${name} because of a problem on our side. Please send it again in a few minutes.`;
		default:
			return `Sorry, we couldn't receive ${name}${message ? `: ${message}` : "."} Please try again.`;
	}
}

module.exports = { MAX_UPLOAD_BYTES, documentOf, documentSize, uploadName, uploadErrorReply };
