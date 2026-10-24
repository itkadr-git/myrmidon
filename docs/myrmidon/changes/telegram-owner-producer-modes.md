---
divergence-section: Трек 4 — чаты и навыки
---

## changelog-en

### Owner Telegram producer modes (U2)

- Preserve the configured owner-DM audience modes: `via_bot` produces no owner-DM publication, `owner_decisions_only` publishes human decisions, and `all` includes agent-addressed and operational interactions. Every eligible owner-only Telegram publication remains plain text without buttons; task-bound vendor routes are unchanged. The default mode is unchanged.

## changelog-ru

### Режимы producer-доставки владельцу в Telegram (U2)

- Сохранить настроенные режимы аудитории owner-DM: `via_bot` не создаёт публикацию в личку владельца, `owner_decisions_only` публикует человеческие решения, а `all` включает интеракции, адресованные агентам, и операционные интеракции. Все подходящие owner-only публикации в Telegram остаются обычным текстом без кнопок; маршруты vendor, привязанные к задаче, не меняются. Режим по умолчанию не меняется.

## divergence

| Track 4 — chats and skills | MYR-1.6.6-RC2 | Preserve producer-side owner-DM audience selection: `via_bot` none, `owner_decisions_only` human decisions, `all` also agent-addressed/operational; eligible owner-only Telegram publications are plain text in every mode; vendor-bound routes unchanged. | Retain explicit instance audience choice without restoring interactive cards for owner-only publications; default unchanged. | `owner-telegram-delivery.myrmidon.test.ts` | Remove mode-specific owner audience selection or return owner-only Telegram projections to cards/buttons. | Pending |