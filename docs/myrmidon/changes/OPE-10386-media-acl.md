---
divergence-section: Track 5 — operations
settings-section: Track 5 — operations
---

## changelog-en

### MEDIA-ACL: scoped media-tool token delivery (MEDIA-ACL)

- Adds an operator-controlled, comma-separated allowlist for binding `MEDIA_TOOLS_TOKEN` into selected Hermes bot environments during the media-tools rollout.
- The allowlist is empty by default; each enabled agent still requires an authorized secret reference, and token values are not passed to adapter environment variables.
- The shared ACL registry is exported through the board compose volume and read-only by the media facade; existing entries are preserved when the generated fleet is empty.

## changelog-ru

### MEDIA-ACL: адресная выдача токенов медиа-инструментов (MEDIA-ACL)

- Добавляет управляемый оператором список имён агентов, которым разрешено передавать `MEDIA_TOOLS_TOKEN` в окружение Hermes во время развёртывания медиа-инструментов.
- Список по умолчанию пуст; для каждого включённого агента по-прежнему нужна авторизованная ссылка на секрет, а значения токенов не передаются в окружение адаптера.
- Общий реестр ACL экспортируется через compose-том доски и читается фасадом только на чтение; существующие записи сохраняются, если сгенерированный fleet пуст.

## settings-en

| `MYRMIDON_BOT_CONTAINER_MEDIA_TOOLS_ENV_ALLOWLIST` | 1.6.6 MEDIA-ACL | `empty` | Comma-separated agent names permitted to receive the `MEDIA_TOOLS_TOKEN` card secret in their Hermes environment during the media-tools rollout. The default empty list enables no agents. Each entry requires an authorized secret reference; token values are never added to adapter environment variables. Enable agents individually only with explicit operator authorization and confirm their ACL entry before use | Empty — no media token bindings. Remove an agent name to revoke this environment binding |

## settings-ru

| `MYRMIDON_BOT_CONTAINER_MEDIA_TOOLS_ENV_ALLOWLIST` | 1.6.6 MEDIA-ACL | `empty` | Имена агентов через запятую, которым разрешено получить секрет `MEDIA_TOOLS_TOKEN` в окружении Hermes во время развёртывания медиа-инструментов. Пустое значение по умолчанию не включает ни одного агента. Для каждой записи нужна авторизованная ссылка на секрет; значение токена никогда не добавляется в окружение адаптера. Включайте агентов по одному только с явным разрешением оператора и проверяйте их запись ACL перед использованием | Пусто — привязки токенов нет. Удалите имя агента, чтобы отозвать эту привязку окружения |
