---
divergence-section: Трек 1 — платформа
---

## changelog-en

### Tool OAuth client secrets can come from a secret reference

- The instance-wide and per-provider OAuth client secret of tool connections can now be bound
  to a stored secret instead of a process environment variable. The value is resolved on the
  server only, masked in logs, and an emergency environment variable still takes priority.
- The MCP gateway token rate-limit settings and the token broker allowed hosts are recorded as
  plain operator configuration, not secrets.

## changelog-ru

### Секреты OAuth-клиента инструментов можно брать из ссылки на секрет

- Общий и поставщик-специфичный секрет OAuth-клиента подключений инструментов теперь можно
  привязать к сохранённому секрету вместо переменной окружения. Значение разрешается только на
  сервере, маскируется в логах, аварийная переменная окружения по-прежнему приоритетнее.
- Лимиты запросов токена шлюза MCP и список разрешённых хостов брокера токенов зафиксированы
  как обычная настройка оператора, а не секреты.
