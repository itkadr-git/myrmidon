---
settings-section: Track 6 — security and models
---

## changelog-en

### Codex / ChatGPT pool account OAuth management, account plans (Plus, Pro, K-12), and sliding window load distribution (OPE-10775)

- Codex / ChatGPT account OAuth connection lifecycle directly from the board UI (`POST /providers/:id/oauth/start` and `POST /providers/:id/oauth/complete`).
- Persistent pool registry supporting subscription account plans (`Plus`, `Pro`, `K-12`) and account deletion.
- Sliding quota window tracking (5 hours and 7 days) with automated exhaustion detection.
- Dynamic account rotation (`selectActivePoolAccount`) automatically removing banned and exhausted accounts from rotation and failing over to available accounts.
- Automatic operator attention role signals for banned (high severity) and quota-exhausted (medium severity) pool accounts.

## changelog-ru

### Пул аккаунтов Codex / ChatGPT: OAuth-авторизация из UI, типы аккаунтов (Plus, Pro, K-12) и распределение нагрузки по скользящим окнам лимитов (OPE-10775)

- Подключение и авторизация аккаунтов Codex по OAuth напрямую из интерфейса доски (`POST /providers/:id/oauth/start` и `POST /providers/:id/oauth/complete`).
- Персистентный реестр пула с поддержкой типов подписок (`Plus`, `Pro`, `K-12`) и удалением учётных записей из пула.
- Отслеживание скользящих окон лимитов (5 часов и 7 дней) с автоматическим определением исчерпания квоты.
- Динамическая ротация аккаунтов (`selectActivePoolAccount`) с автоматическим выводом забаненных и исчерпанных учёток из ротации и переключением на доступную учётку.
- Автоматическая генерация ролевых сигналов внимания оператора для забаненных (высокая важность) и исчерпанных (средняя важность) аккаунтов.
