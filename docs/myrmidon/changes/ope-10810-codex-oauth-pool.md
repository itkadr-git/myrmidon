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
- Added and updated tests:
  - `server/src/myrmidon/model-providers/codex-oauth-pool.myrmidon.test.ts`: verified `isK12Plan`, secret name derivation under `modelProviderAccountSecretName`, pool channel mapping with 5h/7d windows (`p_used`/`p_reset_at`), disabled account status for K-12, ignoring disabled accounts in signal evaluation, and full Codex OAuth lifecycle (`oauthBegin`, `oauthStatus`, `oauthComplete`, `oauthRefresh`).
  - `ui/src/components/myrmidon/model-providers/ModelProvidersScreen.myrmidon.test.tsx`: verified Plus, Pro, K-12 badges, disabled counter and status rendering, and OAuth modal flow.
  - `server/src/myrmidon/model-providers/signals.ts`: verified signal evaluation ignores disabled accounts.

## changelog-ru

### Жизненный цикл Codex OAuth для пула аккаунтов, окна лимитов (5ч/7д) и обработка тарифа K-12 (OPE-10810)

- Реализован жизненный цикл Codex OAuth (`oauthBegin`, `oauthStatus`, `oauthComplete`, `oauthRefresh`) для пулов аккаунтов подписок.
- Строгая изоляция токенов OAuth в secret store (`modelProviderAccountSecretName`) — учетные данные никогда не возвращаются в ответах API и не попадают в UI.
- Добавлена поддержка планов подписок (Plus, Pro, K-12): аккаунты тарифа K-12 (отключены по директиве ADM от 05.11) маркируются как отключенные (`isDisabled: true`), исключаются из живой ротации пула и счетчиков доступных аккаунтов.
- Поддержка 5-часовых скользящих и недельных окон квот с автоматическим определением исчерпания лимитов (`p_used`/`p_reset_at`).
- Обновление интерфейса в ModelProvidersScreen: запуск Codex OAuth и модальное окно авторизации, бейджи тарифов каналов, визуальное отображение отключенного состояния и кнопка обновления токена.
- Добавлены и обновлены тесты:
  - `server/src/myrmidon/model-providers/codex-oauth-pool.myrmidon.test.ts`: проверка `isK12Plan`, изоляции secret store под `modelProviderAccountSecretName`, маппинга окон 5ч/7д (`p_used`/`p_reset_at`), отключенного состояния для K-12, исключения отключенных аккаунтов из генерации сигналов и полного OAuth lifecycle.
  - `ui/src/components/myrmidon/model-providers/ModelProvidersScreen.myrmidon.test.tsx`: проверка рендера тарифов Plus, Pro, K-12, отображения отключенного состояния и OAuth модального окна.
  - `server/src/myrmidon/model-providers/signals.ts`: проверка чистоты генерации сигналов для отключенных аккаунтов.
