## changelog-en

### Users under the administrator's control (USERS-ADMIN-UI part A, server)
- An instance administrator can create board users directly (1.7 USERS-ADMIN-UI A):
  `POST /api/myrmidon/users-admin-a/users` with a login and either a
  password or a one-time password-set link, and a role
  (`instance_admin` or `member`). A user created without an email gets the
  synthetic address `<login>@myr.local` and signs in with the login through
  the new `POST /api/auth/sign-in/username`.
- Blocking (`PATCH /users/:id {blocked}`) closes every live session of the
  user immediately and refuses new sign-ins on every Better Auth path
  (`403 USER_BLOCKED`); unblocking restores access.
- A password reset (`PATCH /users/:id {resetPassword}`) revokes outstanding
  tokens and returns a fresh one-time link; the user picks the new password
  through it (the token is sha256-hashed at rest and dies on first use).
- Self-registration is off by default: `POST /api/auth/sign-up/email`
  answers `403 SELF_SIGN_UP_DISABLED` until the instance enables it
  (`GET/PATCH /api/myrmidon/users-admin-a/self-sign-up`,
  `MYRMIDON_AUTH_SELF_SIGN_UP` as the forced env override). The gate reads
  the setting live, so flipping it needs no restart.
- Every mutation is audit-logged (`instance.user.created/blocked/unblocked/
  password_reset/password_set`) with who, whom, the role granted and the
  block reason. New table `user_password_set_tokens` (migration 0298); the
  block list lives in `instance_settings.general.myrmidonAuthBlockedUsers`.

## changelog-ru

### Пользователи под управлением администратора (USERS-ADMIN-UI часть A, сервер)
- Администратор экземпляра создаёт пользователей доски напрямую (1.7 USERS-ADMIN-UI A):
  `POST /api/myrmidon/users-admin-a/users` с логином и паролем или
  одноразовой ссылкой установки пароля и ролью (`instance_admin` или
  `member`). Пользователь без почты получает синтетический адрес
  `<логин>@myr.local` и входит по логину через новый
  `POST /api/auth/sign-in/username`.
- Блокировка (`PATCH /users/:id {blocked}`) немедленно закрывает все живые
  сессии пользователя и запрещает новые входы на любом пути Better Auth
  (`403 USER_BLOCKED`); разблокировка возвращает доступ.
- Сброс пароля (`PATCH /users/:id {resetPassword}`) отзывает выданные
  токены и возвращает свежую одноразовую ссылку; новый пароль пользователь
  выбирает по ней (токен хранится как sha256 и умирает после первого
  использования).
- Саморегистрация выключена по умолчанию: `POST /api/auth/sign-up/email`
  отвечает `403 SELF_SIGN_UP_DISABLED`, пока экземпляр её не включит
  (`GET/PATCH /api/myrmidon/users-admin-a/self-sign-up`,
  `MYRMIDON_AUTH_SELF_SIGN_UP` — принудительное env-переопределение). Гейт
  читает настройку на каждую попытку, переключение без перезапуска.
- Каждое изменение пишется в журнал активности (`instance.user.created/
  blocked/unblocked/password_reset/password_set`) с указанием, кто, кого,
  с какой ролью и по какой причине. Новая таблица
  `user_password_set_tokens` (миграция 0298); чёрный список блокировок — в
  `instance_settings.general.myrmidonAuthBlockedUsers`.

## divergence-new

<!-- after: DM-PROGRESS: живые шаги в сообщении статуса Telegram-лички -->

### 1.7 — USERS-ADMIN-UI A: пользователи под управлением администратора (сервер)
| 1.7-USERS-ADMIN-A | Плагин Better Auth `usersAdminAuthPlugin` (маркер `myrmidon(1.7 USERS-ADMIN-UI A)` в `server/src/auth/better-auth.ts`): гейт саморегистрации `POST /api/auth/sign-up/email` (403 `SELF_SIGN_UP_DISABLED`, пока экземпляр явно не включил `instance_settings.general.authSelfSignUp`; env `MYRMIDON_AUTH_SELF_SIGN_UP` — принудительное переопределение; читается на каждую попытку, без перезапуска), страж блокировки на `session.create.before` (403 `USER_BLOCKED` на любом пути входа) и эндпоинт `POST /api/auth/sign-in/username` для входа по логину (синтетический адрес `<username>@myr.local`, проверка пароля через `internalAdapter` как у вендорного username-плагина, сессия и cookie — путь вендора). Модуль `server/src/myrmidon/users-admin-a/`: создание пользователя (прямая запись `user`+`account` в форме вендора, издатель `local:credential`; с паролем или одноразовой ссылкой установки), блокировка/разблокировка (список `general.myrmidonAuthBlockedUsers`, транзакционный jsonb_set; при блокировке закрываются все сессии), сброс пароля (новая одноразовая ссылка, старые отзываются), журнал активности (`instance.user.*`). Таблица `user_password_set_tokens` (миграция 0298): sha256 токена, кем/как выдан, история отзыва; само значение возвращается один раз. Роуты `/api/myrmidon/users-admin-a/*` (список — доска, мутации — instance-админ) | Наши файлы: `server/src/myrmidon/users-admin-a/{index,routes,service,store}.ts`, `server/src/auth/users-admin-a-plugin.ts`, `packages/shared/src/myrmidon-auth-self-signup.ts`, `packages/shared/src/myrmidon-auth-noemail.ts`, `packages/db/src/schema/user_password_set_tokens.ts`, миграция `0298_users_admin_a_password_set.sql` (+ journal/snapshot), `server/src/__tests__/users-admin-a.integration.test.ts`. В вендорских файлах помечены `myrmidon(1.7 USERS-ADMIN-UI A)`: `server/src/auth/better-auth.ts` (импорт плагина; `plugins` теперь массив: плагин handoff + наш, поведение handoff не менялось), `server/src/services/instance-settings.ts` (импорт + preserve-строка `myrmidonAuthBlockedUsers` + перенос `authSelfSignUp` в normalizeGeneralSettings), `packages/shared/src/validators/instance.ts` (поля `authSelfSignUp`, `myrmidonAuthBlockedUsers` в general-схеме), `packages/shared/src/types/instance.ts` (поле `authSelfSignUp`), `packages/shared/src/index.ts` (два экспорта), `packages/db/src/schema/index.ts` (экспорт таблицы), `server/src/app.ts` (импорт + `api.use`); тесты вендора `better-auth-credential-signup.integration.test.ts` и `managed-loopback-auth.test.ts` включают саморегистрацию в beforeAll (гейт по умолчанию закрыт). Строки в `docs/myrmidon/SETTINGS.md`/`SETTINGS.ru.md`, гайды `docs/myrmidon/guides/users-admin-a{,.ru}.md` | Релиз 1.7 USERS-ADMIN-UI (часть A, сервер): владелец создаёт пользователей и админов в интерфейсе без приглашений по почте; саморегистрация закрыта по умолчанию. Вендор добавляет пользователей только инвайтом по email, входа по логину нет | `users-admin-a.integration.test.ts` (6 тестов, embedded-PG): вход созданного без почты по логину; отказ регистрации при выключенном гейте, включение настройкой, выключение обратно (live-read); блокировка закрывает сессии и запрещает вход, разблокировка возвращает; сброс пароля одноразовой ссылкой и смерть токена после использования; создание по ссылке установки пароля; роль instance_admin и список с ролями/блокировками | Никогда, наше поведение. Снять: удалить `server/src/myrmidon/users-admin-a/`, `server/src/auth/users-admin-a-plugin.ts`, строки с маркером `myrmidon(1.7 USERS-ADMIN-UI A)` в better-auth.ts/instance-settings.ts/app.ts, поля в shared-схемах, таблицу и миграцию 0298, гайды и разделы SETTINGS/DIVERGENCE | (этот PR) |

## settings-en-new

<!-- after: 1.6.3 — PROMPT-BUDGET C: prompt-budget advice and deep analysis -->

### 1.7 — USERS-ADMIN-UI A: admin-managed users and the self-registration switch
Settings of `server/src/myrmidon/users-admin-a/` and the Better Auth plugin
`server/src/auth/users-admin-a-plugin.ts`. Self-registration is **off by default**;
an instance turns it on explicitly through the settings row the PATCH route writes
(`instance_settings.general.authSelfSignUp`), read live per sign-up attempt — no
restart. The block list (`general.myrmidonAuthBlockedUsers`) and the password-set
token table (`user_password_set_tokens`, migration 0298) carry the rest of the
feature. See `docs/myrmidon/guides/users-admin-a.md` for the full contract.
| `MYRMIDON_AUTH_SELF_SIGN_UP` | USERS-ADMIN-UI A | unset | **Forced override** of the self-registration switch: `1`/`true`/`yes`/`on` opens `POST /api/auth/sign-up/email`, `0`/`false`/`no`/`off` closes it, winning over the stored instance setting | Unset — the stored setting applies; a typo in the value is neither on nor off (the next source decides) |

## settings-ru-new

<!-- after: 1.6.3 — PROMPT-BUDGET C: рекомендации по оптимизации промпта и глубокий разбор -->

### 1.7 — USERS-ADMIN-UI A: пользователи под управлением администратора и переключатель саморегистрации
Настройки `server/src/myrmidon/users-admin-a/` и плагина Better Auth
`server/src/auth/users-admin-a-plugin.ts`. Саморегистрация **выключена по умолчанию**;
экземпляр включает её явно через строку настроек, которую пишет PATCH-маршрут
(`instance_settings.general.authSelfSignUp`), читаемую при каждой попытке регистрации —
без перезапуска. Чёрный список блокировок (`general.myrmidonAuthBlockedUsers`) и таблица
токенов установки пароля (`user_password_set_tokens`, миграция 0298) несут остальную часть
функции. Полный контракт — в `docs/myrmidon/guides/users-admin-a.ru.md`.
| Переменная | Функция | По умолчанию | Что делает | Как отключить / особенности |
| `MYRMIDON_AUTH_SELF_SIGN_UP` | USERS-ADMIN-UI A | не задана | **Принудительное переопределение** переключателя саморегистрации: `1`/`true`/`yes`/`on` открывает `POST /api/auth/sign-up/email`, `0`/`false`/`no`/`off` закрывает, побеждая сохранённую настройку экземпляра | Не задана — действует сохранённая настройка; опечатка в значении не считается ни включением, ни выключением (решает следующий источник) |
