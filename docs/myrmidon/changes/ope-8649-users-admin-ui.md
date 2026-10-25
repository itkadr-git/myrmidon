---
divergence-section: Трек 5 — эксплуатация
settings-section: Track 5 — operations
---

## changelog-en

### Closed self-registration and user administration (OPE-8649)
- Self-registration stays disabled unless `MYRMIDON_AUTH_SELF_SIGN_UP=true` is set explicitly. The runtime setting reports its effective value and source.
- The Users administration flow supports administrator-managed creation, blocking, and password reset. Password reset uses a one-time link.
- Automated coverage checks that registration without an invite is rejected by default and exercises the user-management HTTP lifecycle.

## changelog-ru

### Закрытая саморегистрация и управление пользователями (OPE-8649)
- Саморегистрация выключена, пока явно не задано `MYRMIDON_AUTH_SELF_SIGN_UP=true`. Runtime-настройка показывает итоговое значение и его источник.
- Экран администрирования пользователей поддерживает создание администратором, блокировку и сброс пароля по одноразовой ссылке.
- Автотесты проверяют отказ регистрации без приглашения по умолчанию и HTTP-жизненный цикл управления пользователями.

## settings-en-append

<!-- section: Track 5 — operations -->

Self-registration is off by default. Set `MYRMIDON_AUTH_SELF_SIGN_UP=true` to enable it. The instance setting API reports the effective value and whether it came from an environment variable or an explicit runtime setting. Runtime changes take effect without a server restart.

## settings-ru-append

<!-- section: Трек 5 — эксплуатация -->

Саморегистрация по умолчанию выключена. Для включения задайте `MYRMIDON_AUTH_SELF_SIGN_UP=true`. API настроек экземпляра показывает итоговое значение и источник: переменная окружения или явная runtime-настройка. Runtime-изменения применяются без перезапуска сервера.

## divergence-new

<!-- after: DM-PROGRESS: живые шаги в сообщении статуса Telegram-лички -->

### OPE-8649 — closed self-registration and Users administration
| OPE-8649-USERS-ADMIN | `MYRMIDON_AUTH_SELF_SIGN_UP` default-off setting, admin-managed user lifecycle endpoints, and Better Auth configuration/tests | `packages/shared/src/myrmidon-auth-self-signup.ts`, `server/src/myrmidon/users-admin-a/`, `server/src/auth/better-auth.ts`, `server/src/app.ts`, `packages/db/src/migrations/0401_users_admin_a_password_set.sql` | Registration without an invitation must remain unavailable unless an operator explicitly enables self-registration. The existing Users screen needs working create/block/reset endpoints. | `server/src/__tests__/users-admin-a.integration.test.ts`; Better Auth credential signup integration coverage | Intentional first-party behavior. To remove: remove the self-signup setting and Users administration module, its schema/migration, routes and tests. | OPE-8649 |
