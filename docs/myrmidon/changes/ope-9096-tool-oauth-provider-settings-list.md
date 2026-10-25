---
divergence-section: Трек 1 — платформа
---

## changelog-en

### Per-provider tool OAuth client secrets are listed in settings

- The instance secret settings list now also includes one `tool-oauth.<provider>.client-secret`
  entry for each provider found in connected tool connections that sign in with OAuth. They appear
  in the same panel as the other secret references (current and new interface), so a reference can
  be chosen for each provider without the API. The list never returns a secret value.

## changelog-ru

### Секреты клиента OAuth по провайдерам инструментов видны в настройках

- Список секретных настроек инстанса теперь включает по одной записи
  `tool-oauth.<provider>.client-secret` для каждого провайдера из подключённых tool-соединений с
  OAuth. Они показываются в той же панели, что и остальные ссылки на секреты (текущий и новый
  интерфейс), поэтому ссылку можно выбрать для каждого провайдера без API. Значение секрета список
  не возвращает.
