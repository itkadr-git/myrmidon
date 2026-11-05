---
settings-section: Track 6 — security and models
---

## changelog-en

### Codex OAuth lifecycle for pool accounts, limit windows (5h/7d), and K-12 tariff handling (OPE-10810)

- Implemented Codex OAuth lifecycle (`oauthBegin`, `oauthStatus`, `oauthComplete`, `oauthRefresh`) for subscription pool providers.
- Strict secret-store isolation for OAuth tokens (`modelProviderAccountSecretName`) — credentials are never returned over plain API responses or exposed to UI clients.
- Added subscription plan support (Plus, Pro, K-12): K-12 tariff accounts (disabled per ADM 05.11 directive) are marked disabled (`isDisabled: true`), excluded from live pool rotation and active counts.
- Enforced 5-hour rolling primary and weekly secondary quota window tracking with automated limit exhaustion detection (`p_used`/`p_reset_at`).
- UI enhancements in ModelProvidersScreen: Codex OAuth login trigger and authorization modal, channel plan badges, disabled state indication, and token refresh action.

## changelog-ru

### Жизненный цикл Codex OAuth для пула аккаунтов, окна лимитов (5ч/7д) и обработка тарифа K-12 (OPE-10810)

- Реализован жизненный цикл Codex OAuth (`oauthBegin`, `oauthStatus`, `oauthComplete`, `oauthRefresh`) для пулов аккаунтов подписок.
- Строгая изоляция токенов OAuth в secret store (`modelProviderAccountSecretName`) — учетные данные никогда не возвращаются в ответах API и не попадают в UI.
- Добавлена поддержка планов подписок (Plus, Pro, K-12): аккаунты тарифа K-12 (отключены по директиве ADM от 05.11) маркируются как отключенные (`isDisabled: true`), исключаются из живой ротации пула и счетчиков доступных аккаунтов.
- Поддержка 5-часовых скользящих и недельных окон квот с автоматическим определением исчерпания лимитов (`p_used`/`p_reset_at`).
- Обновление интерфейса в ModelProvidersScreen: запуск Codex OAuth и модальное окно авторизации, бейджи тарифов каналов, визуальное отображение отключенного состояния и кнопка обновления токена.
