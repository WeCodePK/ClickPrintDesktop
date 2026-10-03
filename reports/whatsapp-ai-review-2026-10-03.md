# ClickPrint WhatsApp AI: live QA and improvement report

Date: 3 October 2026  
Recipient verified in WhatsApp contact info: **+92 343 1990047**  
Live session: approximately **14:14–14:26 Asia/Karachi**  
Scope: live customer conversation, desktop WhatsApp integration and settings, backend inference prompt and validation.

## Main findings

The live AI interpreted English, Roman Urdu and Urdu print instructions correctly in this sample. It also preserved file scope and understood a contextual correction without repeated page numbers. The strongest improvements are around conversation entry, payment/support questions, explicit validation errors, draft visibility and operator oversight.

**Excluded contacts are temporary UI state and are not enforced.** They are not fetched from or updated through the backend. A contact shown as excluded can still reach the WhatsApp ordering handler.

A separate code finding is that an absent shop wallet can cause cash submission even when Cash on Pickup is disabled or the total exceeds its limit. This path was reviewed in source; it was not triggered live.

## Method and limits

An agent designed QA cases and reviewed the observed transcript. The main assistant operated the logged-in WhatsApp browser because the agent's separate browser session could not access that tab. The exact recipient number was checked in contact info before any message was sent.

Twelve cases were run: eleven text messages and one upload of a synthetic four-page PDF. The PDF contains only sample QA text, numbered pages and a color rectangle. No private document or payment proof was uploaded.

No confirm, cash-choice, cancellation or order-submission action was sent. Payment completion, printing, reconnect behavior, new-customer onboarding and large-order performance were not tested. The backend folder was inspected without edits. This is one live session, not a model accuracy benchmark.

Timing values below are the delay between sending and the observation that recorded the outcome. A response may have arrived earlier; these values are **not server latency measurements**. “No bot reply” means none was visible in that observation window, not that a reply can never arrive. One message came from a human developer and is identified separately.

The first three messages received no identified bot reply. Later results showed that the earlier three-image draft was still retained. Therefore, initial silence does not prove there was no draft, and the first `price` outcome is an unresolved state/resume diagnostic issue.

## Live results

| Case | Local send time | Input / scenario | Observed outcome |
| --- | --- | --- | --- |
| 1 | 14:14:11 | `Hi` | No identified bot reply after 34 seconds; message delivered. |
| 2 | 14:14:58 | Shop hours and contact number | No identified bot reply after 49 seconds. A human developer message at 14:15 said the bot responds after receiving a document. |
| 3 | 14:16:04 | `price`, before the new upload | No bot reply in the 29-second observation window. Cause not established. |
| 4 | 14:19:51 | Upload synthetic four-page QA PDF | Bot asked for print settings and stated A4, B&W, double-sided defaults. Response observed within 24 seconds. Receipt did not reveal that three earlier files were retained. |
| 5 | 14:20:29 | Page 1 color; remaining pages B&W; single-sided; two copies | **Passed.** Only QA PDF changed. Page 1: 2 × Rs 15 = Rs 30; pages 2–4: 6 × Rs 5 = Rs 30. Earlier images stayed Rs 50. Total Rs 110. |
| 6 | 14:21:33 | Roman Urdu: only QA PDF pages 2–3; one copy; other files unchanged | **Passed.** Selected only pages 2–3, retained single-sided, changed to one copy. QA cost Rs 10; combined total Rs 60. Reply in Roman Urdu. |
| 7 | 14:22:10 | Urdu script: make only QA PDF page 2 color; keep other settings | **Passed.** Page 2 color, page 3 B&W; selection, one copy and single-sided retained. QA cost Rs 20; combined total Rs 70. Reply in Urdu. |
| 8 | 14:22:44 | “Actually, make both selected pages black and white.” | **Passed.** Correctly resolved “both selected pages” to QA PDF pages 2–3. Other settings/files preserved. Total Rs 60. |
| 9 | 14:23:10 | Request QA PDF pages 5–6 | **Poor recovery.** Generic “didn't get that” example, with no explanation that the PDF has four pages. No valid-page question. |
| 10 | 14:23:43 | “Can I pay cash when I pick up?” during active draft | **Unanswered.** No bot reply after 64 seconds; message delivered. |
| 11 | 14:25:09 | Restore only QA PDF to all four pages and default settings | **Passed.** QA PDF A4/B&W/double-sided/portrait/one page per sheet/one copy. Original images unchanged. Total Rs 70. |
| 12 | 14:25:55 | `price`, after upload and restoration | **Passed.** Listed all four files and confirmed Rs 70. Response observed within 41 seconds; actual arrival latency not measured. |

### What worked

- English, Roman Urdu and Urdu script instruction handling.
- Mixed color settings within one document.
- Page selection and copy-count changes.
- Changes scoped to the intended file while preserving earlier files.
- Contextual correction and preservation of settings not mentioned.
- Consistent arithmetic and summaries in the observed cases.

## Prioritized improvements

### 1. Make excluded contacts real — high priority

**Current behavior:** [WhatsAppSettings.jsx](D:/clickPrint/ClickPrintDesktop/renderer/src/dashboard/components/settings/WhatsAppSettings.jsx:39) explicitly describes the feature as UI-only. `useExcludedContacts()` starts with `useState([])`; add/remove only update this state. There is no load effect, backend request, IPC invocation or durable store for exclusions.

Leaving/reopening this section or restarting the renderer resets the list. More importantly, the list never reaches the incoming-message handler. [whatsapp.js](D:/clickPrint/ClickPrintDesktop/main/whatsapp.js:287) filters message origin/group type and global pause, then routes incoming media/text without checking excluded identities.

The [Shop schema](D:/clickPrint/ClickPrintBackend/src/models/Shop.js:85) has no exclusion field; the [shop update allowlist](D:/clickPrint/ClickPrintBackend/src/routes/Shops.js:52) does not accept one. No corresponding exclusion endpoint was found in the backend source search.

**Recommended implementation:** save per-shop exclusions through an owner-authorized backend API; fetch them on opening settings and when linking/selecting a shop. Route updates through main-process IPC and keep a main-process snapshot for incoming messages. Match normalized international phone identities and LID/phone mappings before marking read, uploading media, creating drafts or calling inference. Do not treat a LID's digits as a phone number.

Show loading/saving/errors and rollback failed changes. Verify persistence after reopening settings, restarting the app and using another device, plus actual prevention of text/media processing. Until implemented, the UI should accurately describe the feature's state.

### 2. Enforce Cash on Pickup even when the wallet is absent — high priority

[choosePayment](D:/clickPrint/ClickPrintDesktop/main/whatsappChatFlow.js:641) computes eligibility as `total < codLimit`. If no wallet exists, it nevertheless proceeds to `placeOrder`; the source even logs that an over-limit order is being placed as cash.

This can bypass `codLimit: 0` (Cash on Pickup off) or an exceeded limit. It was not exercised live.

**Recommended behavior:** if permitted cash and configured online payment are both unavailable, retain the draft, explain that the shop must assist, and flag the operator. Never silently fall back to cash. Define whether the threshold itself is eligible and keep the app's wording, backend policy and tests consistent. Cover disabled COD, below/equal/above limit, missing wallet and failed shop fetch.

### 3. Answer relevant questions and expose human handoff — high priority

The live cash-on-pickup question was unanswered even with an active draft. The [backend prompt](D:/clickPrint/ClickPrintBackend/src/func/inference.js:53) labels greetings, pickup times, delivery, payment and shopkeeper questions as `offtopic`. The [desktop handler](D:/clickPrint/ClickPrintDesktop/main/whatsappChatFlow.js:586) usually stays silent for this intent.

**Recommended behavior:**

- Send a short, throttled welcome/help message explaining the file-first flow.
- Answer hours, contact and Maps questions from trusted shop-profile data.
- Explain payment eligibility from the current total and shop COD/wallet configuration without placing an order.
- Offer “shopkeeper/help” and show a pending-help conversation to the operator.
- Distinguish “received”, “awaiting payment proof”, “awaiting payment verification”, “printing” and “ready for collection”. Do not promise completion times without operator/backend information.

Changing only the system prompt will not add these replies. The intent/schema and desktop handlers need to support them.

### 4. Explain invalid settings and technical failures — medium priority

The four-page PDF's pages 5–6 request produced:

> Sorry, I didn't get that. Try e.g. all color, double sided, 2 copies

A useful response would be: “This PDF has 4 pages. Choose pages 1–4. Your previous selection is unchanged.”

[Backend sanitization](D:/clickPrint/ClickPrintBackend/src/func/inference.js:281) drops invalid changes without a customer-facing reason. [Inference failures](D:/clickPrint/ClickPrintDesktop/main/whatsappChatFlow.js:557) also use the same misunderstanding template, including technical failures.

**Recommended behavior:** return structured validation reasons, supported limits and a focused question. Preserve the valid draft. Separate ambiguity from network, unavailable-model, timeout and rate-limit errors; offer retry or shop assistance instead of implying that the customer phrased a valid request badly.

### 5. Make active drafts visible and editable — medium priority

The receipt said “this file” and listed defaults. The next summary revealed that three earlier images were still in the order. The new PDF increased an existing draft rather than creating an isolated one.

**Recommended behavior:** acknowledge “Added to your existing order — 4 files” and show a short current-order summary. Offer explicit add-to-current/start-new decisions, pending-draft expiry/resume feedback, and a way to remove a single file. Avoid requiring cancellation of the entire draft to remove an accidental attachment.

Default settings should be understandable in the summary without decoding service labels such as `A4-BW-DS`. Keep detailed costing available, but use plain “A4 · B&W · double-sided · 1 copy” labels.

### 6. Clarify payment-proof uploads — medium priority

[addFile](D:/clickPrint/ClickPrintDesktop/main/whatsappChatFlow.js:469) treats the next uploaded file as payment proof while waiting for proof; [attachProof](D:/clickPrint/ClickPrintDesktop/main/whatsappChatFlow.js:679) attaches it and submits the draft. A customer intending to add another print document has no explicit choice at that point.

Offer “payment proof” versus “another file to print”, check accepted evidence types and state that the shop must verify the payment. The existing [manual-printing rule](D:/clickPrint/ClickPrintDesktop/main/jobRules.js:21) should remain in force for comments/proof jobs.

### 7. Improve comment correction and context handling — medium priority

[withComment](D:/clickPrint/ClickPrintDesktop/main/whatsappChatFlow.js:596) appends instructions and retains the last 500 characters. A correction such as “no binding after all” can leave conflicting earlier instructions. Comments were not tested live because this session used an existing draft.

Represent add/replace/remove operations explicitly and ask about conflicts. Keep a compact structured order state for follow-ups: [remember](D:/clickPrint/ClickPrintDesktop/main/whatsappChatFlow.js:455) retains six history entries and trims bot summaries to 200 characters, while file context keeps only the first 20 setting runs.

### 8. Match inference capacity to supported complexity — medium priority

The backend allows 50 files and 20 changes, but [inference](D:/clickPrint/ClickPrintBackend/src/func/inference.js:241) fixes output at 500 tokens and does not inspect the completion finish reason. A complex strict-schema response can exceed that budget. This is a source risk, not a live failure observed here.

Measure output lengths, set a suitable budget, handle truncation explicitly and return a clear complexity limit. Do not silently discard requested changes.

## Backend prompt review and proposed tuning

The prompt lives in [src/func/inference.js](D:/clickPrint/ClickPrintBackend/src/func/inference.js:40). The model produces structured intent/settings; the desktop constructs customer replies. The backend route checks shop ownership and rate limits before inference.

Strengths include a strict output schema, known setting values, page-range checks, multilingual examples, nullable unchanged fields and instructions to avoid invented prices/times. The live successful cases are consistent with these design choices.

Suggested next revision, with corresponding schema/desktop support:

1. Split printing-related support from unrelated chat. Include shop-info/payment/help intents that route to deterministic handlers.
2. Require a focused clarification for impossible pages/copies or unavailable services; return validation details rather than dropping an invalid change.
3. Clarify exclusive corrections: “only the last file landscape” should either set other files to portrait or ask whether earlier landscape settings should be reverted. Earlier user-authored chat history showed this phrase retaining all landscape files until an explicit correction. That history was reviewed, not counted as a new QA case.
4. Treat comment corrections as replacements/removals, preserving the customer's current intention.
5. Include trusted available services and structured current-order state; continue deriving actual prices from the backend.
6. Add examples for mixed-language follow-ups, negative payment requests and ambiguous file references.
7. Keep confirmation and payment submission controlled by the application state machine.

No prompt or backend code was changed.

## Suggested implementation sequence and evaluation

1. Persist/enforce exclusions and block invalid cash fallback.
2. Add welcome, shop-info, payment guidance and visible operator handoff.
3. Add explicit validation/error responses and active-draft file management.
4. Improve prompt/context and collect aggregate operational metrics.

Useful measurements: time to first useful response, inference failures by type, clarification recovery, file-scope errors, draft abandonment, payment completion and operator handoffs. Use synthetic scenarios and avoid retaining full customer chat content merely for metrics.

Regression cases should include: excluded phone/LID text and media; app restarts; COD off/missing wallet; threshold equality; invalid page ranges/copies; comments removed or replaced; additional print file during proof stage; multi-file exclusive corrections; English/Roman Urdu/Urdu follow-ups; network failure; and truncated inference output.

## Final live state

The draft remains **unsubmitted**. Original three images retained their earlier settings and Rs 50 combined cost. The synthetic QA PDF remains appended, restored to all four pages, A4, B&W, double-sided, portrait, one page per sheet and one copy, adding Rs 20. Final combined draft total: **Rs 70**.

Do not submit this draft unchanged if the QA file is not intended for printing. The original draft was not cancelled to clean up the test attachment.

Only the QA fixture and this report were created in the desktop workspace. Backend source was read without edits.

## Exact sent text

1. `Hi`
2. `What are your shop hours and contact number?`
3. `price`
4. Uploaded `clickprint-whatsapp-qa-4-pages.pdf`.
5. `For this PDF, page 1 in color, the remaining pages black and white, single-sided, 2 copies.`
6. `Sirf is QA PDF ke pages 2 se 3 chahiye, 1 copy. Baqi files ki settings same rakho.`
7. `صرف اسی QA PDF کے صفحہ 2 کو رنگین کریں، باقی سیٹنگز وہی رہیں۔`
8. `Actually, make both selected pages black and white. Everything else stays the same.`
9. `For the QA PDF only, use pages 5 to 6. Keep the other files unchanged.`
10. `Can I pay cash when I pick up?`
11. `Restore only clickprint-whatsapp-qa-4-pages.pdf to all 4 pages, A4, black and white, double-sided, portrait, 1 page per sheet and 1 copy. Leave the original three images unchanged.`
12. `price`
