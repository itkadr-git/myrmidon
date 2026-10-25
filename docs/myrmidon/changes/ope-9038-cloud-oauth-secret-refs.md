---
divergence-section: Трек 1 — платформа
---

## changelog-en

### Cloud connector OAuth client secrets can come from a secret reference

- The OAuth client secret of the OneDrive, Google Drive and Yandex Disk connectors can now be
  bound to a stored secret instead of a process environment variable. The value is resolved on
  the server at connect and refresh time only, masked in logs, and an emergency environment
  variable still takes priority.
- The connector's identity keys stay environment-only, and the Cloud runtime identity key set
  (public keys) is recorded as plain configuration.

## changelog-ru

### Секреты OAuth-клиентов облачного коннектора можно брать из ссылки на секрет

- Секрет OAuth-клиента коннекторов OneDrive, Google Drive и Яндекс Диска теперь можно привязать
  к сохранённому секрету вместо переменной окружения. Значение разрешается только на сервере при
  подключении и обновлении токена, маскируется в логах, аварийная переменная окружения
  по-прежнему приоритетнее.
- Ключи идентичности коннектора остаются только в окружении, а набор ключей Cloud runtime
  identity (открытые ключи) зафиксирован как обычная настройка.
