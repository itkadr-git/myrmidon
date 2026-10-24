## changelog-en

### Users screen works: create, block, reset password with a one-time link (OPE-8985)
- The server half of the "Users" screen is in: `GET/POST /api/myrmidon/users-admin-a/users`
  and `PATCH /api/myrmidon/users-admin-a/users/:userId` (`{blocked}`, `{resetPassword: true}`
  returning `{passwordSetLink}`). Instance administrator only; anyone else gets 403.
- A user is created with a login, a name, a role and an optional temporary password. Without a
  password the answer carries a one-time link. The account address is `<login>@myr.local`; the
  user signs in on the normal form with it.
- The link opens the public page `/password-set/<token>`, where the user sets a password
  (`POST /api/myrmidon/users-admin-a/password-set`). It works once and for 24 hours; the
  database keeps only the sha256 of the token; a newer reset revokes the older link; setting
  a password closes the user's other sessions.
- Blocking closes the user's sessions and refuses any new sign-in (`403 USER_BLOCKED`).
- Every action is written to the activity log (`instance.user.*`). Self-registration is not
  changed. Migration 0412 (`user_password_set_tokens`, `user_blocks`).

## changelog-ru

### Экран «Пользователи» работает: создание, блокировка, сброс пароля одноразовой ссылкой (OPE-8985)
- Серверная часть экрана «Пользователи»: `GET/POST /api/myrmidon/users-admin-a/users` и
  `PATCH /api/myrmidon/users-admin-a/users/:userId` (`{blocked}`, `{resetPassword: true}` с
  ответом `{passwordSetLink}`). Только администратор экземпляра, остальным 403.
- Пользователь создаётся с логином, именем, ролью и необязательным временным паролем. Без
  пароля в ответе одноразовая ссылка. Адрес учётной записи `<логин>@myr.local`, вход на
  обычной форме по нему.
- Ссылка открывает публичную страницу `/password-set/<токен>`, где пользователь задаёт пароль
  (`POST /api/myrmidon/users-admin-a/password-set`). Работает один раз и 24 часа; в базе только
  sha256 токена; новый сброс отзывает прежнюю ссылку; смена пароля закрывает остальные
  сессии пользователя.
- Блокировка закрывает сессии и запрещает новый вход (`403 USER_BLOCKED`).
- Каждое действие пишется в журнал активности (`instance.user.*`). Саморегистрация не
  менялась. Миграция 0412 (`user_password_set_tokens`, `user_blocks`).

## divergence-new

<!-- after: DM-PROGRESS: живые шаги в сообщении статуса Telegram-лички -->

### OPE-8985 — пользователи под управлением администратора (сервер)
| OPE-8985-USERS-ADMIN | Модуль `server/src/myrmidon/users-admin-a/` (маршруты, сервис): список, создание (логин+имя+роль, пароль или одноразовая ссылка), блокировка с закрытием сессий, сброс пароля ссылкой, публичный `POST /password-set`. Хук `databaseHooks.session.create.before` в `server/src/auth/better-auth.ts` (403 `USER_BLOCKED`). Страница `ui/src/pages/PasswordSet.tsx` и маршрут `password-set/:token` в `ui/src/App.tsx`. Таблицы `user_password_set_tokens` (хранится sha256 токена, срок 24 ч, отзыв) и `user_blocks`, миграция 0412 | Наши файлы: `server/src/myrmidon/users-admin-a/{index,routes,service}.ts`, `packages/db/src/schema/user_password_set_tokens.ts`, миграция `0412_users_admin_a.sql` (+ journal/snapshot), `ui/src/pages/PasswordSet.tsx`, тесты. В вендорских файлах помечено `myrmidon(OPE-8985)`: `server/src/auth/better-auth.ts`, `server/src/app.ts`, `ui/src/App.tsx`, `packages/db/src/schema/index.ts` | Экран «Пользователи» (#1347) ходил на несуществующий маршрут и показывал 404; вендор добавляет пользователей только инвайтом по почте | `server/src/__tests__/users-admin-a-routes.test.ts` (права 403, создание, блокировка, сброс, одноразовость и срок ссылки) | Никогда, наше поведение. Снять: каталог модуля, строки с маркером в четырёх вендорских файлах, таблицы и миграцию 0412, страницу | OPE-8985 |
