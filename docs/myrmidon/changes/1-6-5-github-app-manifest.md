## changelog-en

### Register a GitHub App in one click from the company settings (GITHUB-APP-MANIFEST)

- Company settings → "Shared GitHub authorization" can now register a GitHub
  App through GitHub's manifest flow instead of hand-filling GitHub's form
  and pasting a .pem: `POST
  /api/myrmidon/companies/:companyId/github-shared-identity/app-manifest/begin`
  returns the GitHub form URL, the manifest JSON (private app, webhooks
  off, exactly contents + pull requests write and metadata read) and an
  unguessable anti-CSRF `state` the form posts alongside the manifest; the
  browser callback converts GitHub's one-time code only when the `state`
  GitHub echoes back matches the one begin issued for this company and actor
  (one-time use, ten-minute TTL) — a code without a live state is refused
  before GitHub is called — and stores the App's private key
  straight into a company secret — the key never appears in a response, a log
  line or an error — and `GET
  /api/myrmidon/companies/:companyId/github-shared-identity/apps/:entryId/install`
  returns the App's "Install on GitHub" URL. The callback redirects back to
  the settings with `github_app_created=1` or `github_app_error=<message>`.
- The App entry gains a nullable `slug` (additive; no migration — the
  document lives in `instance_settings.general`); the manual path (App id +
  key secret) keeps working unchanged, with or without a slug.

## changelog-ru

### Зарегистрировать GitHub App в один клик из настроек компании (GITHUB-APP-MANIFEST)

- Настройки компании → «Shared GitHub authorization» теперь умеют
  регистрировать GitHub App через манифест-поток GitHub, без ручного
  заполнения формы и без файла .pem в руках: `POST
  /api/myrmidon/companies/:companyId/github-shared-identity/app-manifest/begin`
  возвращает URL формы GitHub, JSON манифеста (приватное приложение,
  вебхуки выключены, права ровно contents + pull requests на запись и
  metadata на чтение) и неподборный anti-CSRF `state`, который форма отправляет
  вместе с манифестом; браузерный callback обменивает одноразовый код GitHub,
  только когда `state`, который GitHub вернёт в редиректе, совпадает с выданным
  begin'ом для этой компании и автора (одноразовый, TTL 10 минут), — код без
  живого state отклоняется до обращения к GitHub, — и сразу кладёт приватный ключ приложения в секрет компании — ключ не
  попадает ни в ответ, ни в журнал, ни в ошибку — а `GET
  /api/myrmidon/companies/:companyId/github-shared-identity/apps/:entryId/install`
  возвращает URL установки приложения на GitHub. Callback возвращает в
  настройки с `github_app_created=1` или `github_app_error=<сообщение>`.
- Запись приложения получила необязательное поле `slug` (аддитивно; миграции
  нет — документ живёт в `instance_settings.general`); ручной путь
  (App id + секрет с ключом) работает как раньше, со slug и без.

## divergence-new

<!-- after: 1.6.4 — AUTONOMY-DELETE: исполнение класса `delete` на DELETE-маршрутах задач -->

### 1.6.5 — GITHUB-APP-MANIFEST: регистрация GitHub App манифестом из настроек компании

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| GITHUB-APP-MANIFEST | Регистрация собственного GitHub App в один клик из настроек компании (манифест-поток GitHub): `POST …/github-shared-identity/app-manifest/begin` (URL формы + JSON манифеста: public=false, вебхуки выключены, права contents/pull_requests write + metadata read, redirect на callback доски + anti-CSRF `state` — неподборный, привязан к компании и автору, одноразовый, TTL 10 минут, хранится в памяти процесса доски), `GET …/app-manifest/callback` (сначала проверка `state`, который GitHub возвращает в редиректе: код без живого state отклоняется до обращения к GitHub; затем обмен одноразового кода `POST /app-manifests/{code}/conversions`; приватный ключ сразу в секрет компании и нигде не печатается; запись приложения добавляется со slug; ответ — 302 с `github_app_created=1` или `github_app_error`), `GET …/apps/:entryId/install` (`https://github.com/apps/<slug>/installations/new`; запись без slug — 422). В схеме записей приложений аддитивное поле `slug` (default null, без миграции — `instance_settings.general`); ручной путь не меняется | Вендор, помечено `myrmidon(GITHUB-APP-MANIFEST)`: `server/src/myrmidon/github-shared-identity/index.ts` (три маршрута), `server/src/myrmidon/github-shared-identity/settings.ts` (поле `slug`); наши: `server/src/myrmidon/github-shared-identity/app-manifest.ts`, `ui/src/components/myrmidon/githubSharedIdentityApi.ts` (тип), `ui/src/components/myrmidon/GitHubSharedIdentityPanel.tsx` (`state` в форме) | Владелец: создание GitHub App в один клик, без ручной формы и без .pem в руках; ключ сразу в хранилище секретов; callback не обменивает чужой или навязанный код | `server/src/__tests__/github-app-manifest.myrmidon.test.ts` (begin user/org, поля манифеста и state, callback: ключ в секрете и нигде больше, 302 с `github_app_created=1`, 422 GitHub → `github_app_error` без секрета и без записи, без кода, без state / чужой state / повторный state — отказ до вызова GitHub, чужая компания и агент — отказ, install по slug и без slug; ручной путь — существующий suite) | Никогда, наше поведение. Снятие: удалить `app-manifest.ts`, маршруты и поле `slug` (схема читает старые документы без него) | (этот PR) |
