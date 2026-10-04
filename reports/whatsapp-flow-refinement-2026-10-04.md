# WhatsApp flow refinement — 4 October 2026

## Desktop changes

- Document removal is handled before inference: exact filenames, unique filename fragments, file numbers, first/second/last references and the current document. A WhatsApp reply quoting an uploaded document identifies that document. Ambiguous or conflicting references ask for a number or filename. Removing pages or print settings is not treated as removing a document.
- Removal updates the existing backend draft through the existing API and recalculates the total. Removing the last document deletes the draft. Failed updates preserve the current order. Any pending payment selection/proof is cleared after a document/settings change.
- Payment selection briefly lists Cash on Pickup and online bank transfer, followed by “collect at the shop counter”. File receipts and order summaries have no pickup/payment footer. All delivery-unavailability sentences were removed from customer reply templates in English, Roman Urdu and Urdu. Payment/pickup questions receive deterministic replies instead of being ignored. Cash limits, wallet requirements and the existing online-payment path are retained.
- The first non-document message gets a short welcome with the shop name through the shared incoming handler, before selecting either ordering style. A document upload does not consume the greeting. The welcome is recorded per customer and shop on disk only after WhatsApp successfully sends it. Existing print instructions are still processed after that first welcome if the customer already has a draft. Voice notes, stickers and other ordinary non-document messages also trigger it. Ephemeral-chat wrappers are handled too.
- Drafts expire after 10 minutes without incoming activity. Timestamps are persisted. Every new message checks expiry; background cleanup also runs every 30 seconds and at shop login. A new upload after expiry starts a fresh draft. Drafts saved by an older version without an activity timestamp are treated as expired.
- Expired drafts are immediately detached locally. Their backend deletion is retried from a disk-backed queue if the network is unavailable. Already submitted jobs are not expired. Backend uploaded files and the customer's WhatsApp messages are not erased by this draft cleanup.
- `cancel`, `close session`, `end session`, `start over` and `new order` close an open draft. WhatsApp does not provide an event when a customer merely closes the chat window; the inactivity timeout covers that case.

## Backend prompt additions — APPLIED

Approved by the user and applied on 4 October 2026. Only the `SYSTEM_PROMPT` string was changed.

Target: `D:/clickPrint/ClickPrintBackend/src/func/inference.js`, only the `SYSTEM_PROMPT` string.

The existing structured-output schema has no file-removal intent. A prompt change alone cannot add a reliable removal action through that schema. The desktop now handles supported removal commands directly. For more complex removal requests that still reach inference, this proposal guides customers to the explicit command rather than inventing a print-setting change or cancelling the whole order.

### Exact prompt additions

The following text was inserted immediately before `Examples (files: 1 = "notes.pdf", 12 pages):`:

```text
Document removal and session commands:
- Removing one document is not cancelling the whole order, changing its print settings, or a comment for the shop. Do not turn a file-removal request into "cancel" or put it in comment.
- The software handles explicit commands such as "remove notes.pdf" and "remove file 2". If a document-removal request reaches you, return "unclear", changes [], comment "", and one short clarification in the customer's language. If the target is uniquely known, ask them to confirm using "remove <exact filename>" or "remove file <n>". If the target is ambiguous, ask which filename or file number to remove. Do not claim that anything has been removed.
- Reserve "cancel" for an explicit request to close the whole order. Never interpret a negation, hypothetical question, or a request about a particular file as whole-order cancellation.

Validation and reply quality:
- If a requested page range exceeds a target file's page count, return "unclear" with a short question stating that file's actual page count and asking for a valid selection. Do not silently drop, clamp, or invent the requested range.
- Copies must be a whole number from 1 to 100. If the customer requests an invalid count, return "unclear" and ask for a count within that range.
- If a file reference matches several filenames or cannot be identified, ask which file they mean. Never widen an unresolved target to all files.
- Keep questions short, specific, and in the customer's language. Preserve settings they did not ask to change. Do not claim an order was submitted, a payment was verified, or prints are ready.
- Payment and pickup questions remain "offtopic" in this schema; the software answers them from the shop configuration. Never infer "confirm" from a payment question and never store a payment/pickup question in comment.
```

These examples were appended after the existing examples:

```text
- "do not remove notes.pdf" -> offtopic, en, [], comment: ""
- "remove the document I sent before this one" (target not uniquely known) -> unclear, en, [], question: "Which document should I remove? Reply with its filename or file number."
- "notes.pdf ko order se nikalna hai" -> unclear, roman_urdu, [], question: "notes.pdf remove karni hai? Tasdeeq ke liye remove notes.pdf likhen."
- "use pages 13-15" (notes.pdf has 12 pages) -> unclear, en, [], question: "notes.pdf has 12 pages. Which pages from 1-12 should I print?"
- "Can I pay cash when I collect?" -> offtopic, en, [], comment: ""
```

No schema, route, model, LiteLLM configuration, token budget or other backend code was changed.

## Validation

Source review and JavaScript syntax checks only. Automated tests and a live WhatsApp conversation were not run for this revision.
