---
divergence-section: Трек 4 — чаты и навыки
---

## changelog-en

### Owner Telegram questions as plain text (U2)

- Deliver owner-only Telegram question and safe confirmation publications as readable text without inline buttons. Preserve option descriptions and the durable interaction publication contract.

## changelog-ru

### Вопросы владельцу в Telegram обычным текстом (U2)

- Доставлять вопросы и безопасные подтверждения владельцу в Telegram обычным текстом, без inline-кнопок. Сохранять описания вариантов и контракт durable-публикации взаимодействия.

## divergence

| Track 4 — chats and skills | MYR-1.6.6-RC2 | Owner-only Telegram `ask_user_questions` and safe `request_confirmation` publications become plain-text messages with no action buttons or executable tokens; task-bound vendor bindings and non-Telegram channels retain current behavior. | Owner DM guidance requires human-readable prompts, complete options and safe confirmation details without inline controls. | `owner-telegram-delivery.myrmidon.test.ts` | Remove the owner-only text projection and renderer; restore the existing card projection. | PR #1258 |
