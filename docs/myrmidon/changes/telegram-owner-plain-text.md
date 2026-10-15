---
divergence-section: Трек 5 — эксплуатация
---

## changelog-en

### Owner Telegram questions as plain text (U2)

- Deliver owner-only Telegram question and safe confirmation publications as readable text without inline buttons. Preserve option descriptions and the durable interaction publication contract.

## changelog-ru

### Вопросы владельцу в Telegram обычным текстом (U2)

- Доставлять вопросы и безопасные подтверждения владельцу в Telegram обычным текстом, без inline-кнопок. Сохранять описания вариантов и контракт durable-публикации взаимодействия.

For the additive owner-only Telegram DM projection, render safe `ask_user_questions` and `request_confirmation` interactions as readable plain text without cards, inline keyboards, callback actions, link actions, or executable action tokens. Preserve the canonical interaction ID, company, endpoint, conversation, task and existing provider receipt in the durable publication outbox. Keep existing owner filters, safe projection and redaction. Leave task-bound vendor conversations and non-Telegram providers on their current behavior.

The question text includes its title, prompt and help text, all numbered options with descriptions, an explicitly-present recommendation only, task URL and reply instruction. Confirmation text includes supplied details, target and consequences. Where Telegram lacks a native confirmation path, say the interaction can only be answered on the board and include its URL; do not suggest that a chat reply resolves it. Exclude tool, secret and connection-authorization proposals.

Reject projections exceeding Telegram's 4,096-character limit; never silently truncate.

No shared schema changes or new dependencies are introduced by this divergence.
