## changelog-en

### Operator attention cards for expiring and expired MCP gateway tokens (OPE-12517, PR #2799)

- Added the `mcp_gateway_token_expiring` attention source kind to the operator attention feed (`packages/shared/src/types/attention.ts`, `server/src/services/attention.ts`).
- Proactively surfaces unrevoked MCP gateway tokens whose `expiresAt` is within 14 days (`expiresAt <= now + 14 days`), as well as tokens that have already expired. Tokens without an expiry date (`expiresAt IS NULL`) and revoked tokens are excluded.
- Differentiates recommended operator actions based on token usage history (`lastUsedAt`):
  - Tokens expiring in the future or expired tokens that were actively used (`lastUsedAt IS NOT NULL`) recommend rotation (`rotate`), offering action verbs `rotate`, `revoke` (if expired), and `dismiss`, with severity `medium` (expiring) or `high` (expired).
  - Tokens that are already expired and were never used (`lastUsedAt IS NULL`) explicitly recommend revocation (`revoke`), offering action verbs `revoke`, `rotate`, and `dismiss` with severity `high`. Note that unused expired tokens are NOT automatically revoked; an operator action is recommended.
- Links directly to the affected gateway settings page (`/<prefix>/settings/gateways/:gatewayId`).
- Guarantees credential confidentiality: token hashes (`tokenHash`) and token prefixes are never exposed in card descriptions, subjects, metadata, or excerpts.
- Cards are company-isolated, deduplicated by token ID (`mcp-gateway-token-expiring:${tokenId}`), and automatically exit the feed once the token is rotated, revoked, has its expiry extended, or the card is dismissed.

## changelog-ru

### Карточки внимания оператора для истекающих и истекших токенов MCP-шлюзов (OPE-12517, PR #2799)

- В ленту внимания оператора добавлен новый источник `mcp_gateway_token_expiring` (`packages/shared/src/types/attention.ts`, `server/src/services/attention.ts`).
- Карточки заблаговременно предупреждают о скором истечении срока неотзванных токенов шлюзов MCP с порогом 14 дней (`expiresAt <= now + 14 days`), а также об уже истекших токенах. Бессрочные токены (`expiresAt IS NULL`) и уже отозванные токены исключаются.
- Рекомендуемые действия разделяются в зависимости от истории использования токена (`lastUsedAt`):
  - Для токенов, истекающих в будущем, или уже истекших токенов, которые использовались (`lastUsedAt IS NOT NULL`), рекомендуется ротация (`rotate`), доступны действия `rotate`, `revoke` (для истекших) и `dismiss`, уровень важности `medium` (истекающие) или `high` (истекшие).
  - Для уже истекших токенов, которые ни разу не использовались (`lastUsedAt IS NULL`), явно рекомендуется отзыв (`revoke`), доступны действия `revoke`, `rotate` и `dismiss`, важность `high`. Автоматического отзыва не происходит — оператору предлагается явное действие.
- Карточка содержит прямую ссылку на страницу настроек шлюза (`/<prefix>/settings/gateways/:gatewayId`).
- Гарантируется безопасность учетных данных: хеши токенов (`tokenHash`) и префиксы токенов никогда не утекают в заголовки, описания, метаданные или краткие выжимки карточек.
- Карточки строго изолированы по компаниям, дедуплицируются по идентификатору токена (`mcp-gateway-token-expiring:${tokenId}`) и автоматически исчезают из ленты при ротации, отзыве, продлении срока действия токена или закрытии (dismiss) уведомления оператором.
