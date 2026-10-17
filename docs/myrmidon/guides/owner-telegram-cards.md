# Agent question and confirmation cards delivered to the owner's Telegram

> Russian version: [owner-telegram-cards.ru.md](owner-telegram-cards.ru.md)

## Plain-text owner publications

The additive owner-only Telegram DM projection for `ask_user_questions` and safe `request_confirmation` interactions is readable text, without cards or inline buttons. It is selected only when no live task-bound chat conversation exists, and only when the existing owner and endpoint filters match. Vendor task conversations retain their current provider-specific behavior.

A question message includes its title, prompt and help text, all numbered options with descriptions, the task URL as plain text, and the instruction: "Ответьте сообщением: номером варианта или своими словами." Show a recommendation only if explicitly present in source data.

A safe confirmation includes its prompt and details, along with a supplied target and consequences. When no Telegram-native confirmation path can resolve it, say it can only be answered on the board and include the task URL; do not imply that a text reply will resolve it. Exclude tool-action, secret-proposal, and connection-authorization content.

Reuse the durable publication outbox and preserve the canonical interaction ID and provider receipt. Do not create callback actions, link buttons, or executable action tokens for the owner-only projection, even if the endpoint advertises action support. Preserve owner filters and redaction. Reject the complete message if it exceeds Telegram's 4,096-character limit; do not silently truncate it.
The delivery mode uses the instance's owner-delivery setting (`instance_settings.general[ownerDelivery]`; `GET /api/myrmidon/owner-delivery` and `PATCH /api/myrmidon/owner-delivery`).
