---
divergence-section: Трек 1 — платформа
settings-section: Track 1 — platform
---

## changelog-en

### DEBRAND runtime environment aliases (OPE-8124)

- Runtime consumers resolve MYRMIDON_* environment variables first and retain PAPERCLIP_* fallback through the centralized compatibility resolver for the 1.6.6 transition.

## changelog-ru

### DEBRAND: синонимы runtime-переменных окружения (OPE-8124)

- Runtime-потребители в первую очередь разрешают MYRMIDON_* и сохраняют fallback PAPERCLIP_* через централизованный resolver на переходный период 1.6.6.

## divergence

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| OPE-8124 | Runtime consumers use MYRMIDON_* first and legacy PAPERCLIP_* fallback through the centralized resolver | server/src/**, packages/shared/src/** | Standard startup no longer requires old names | Resolver precedence and affected runtime suites | Remove fallback after 1.6.6 compatibility window | PR #1410 |

## settings-en

| `MYRMIDON_CLOUD_TENANT_SERVER_TOKEN` | 1.6.6 DEBRAND | unset | Credential used by cloud tenant routes | Unset disables token-authenticated tenant routes |
| `MYRMIDON_PROCESS_ROLE` | 1.6.6 DEBRAND | `all` | API, worker, or combined server process role | Unset defaults to `all`; accepted values are `all`, `worker`, and `api` |
| `MYRMIDON_RUN_SCRATCH_DIR` | 1.6.6 DEBRAND | TMPDIR or OS temp directory | Directory for ephemeral SSH operation files | Unset falls back to TMPDIR then OS temp directory |
| `MYRMIDON_SCRATCH_DIR` | 1.6.6 DEBRAND | home scratch fallback | Approved directory for ephemeral site-agent PKI files | Unset uses MYRMIDON_RUN_SCRATCH_DIR then home scratch |

## settings-ru

| `MYRMIDON_CLOUD_TENANT_SERVER_TOKEN` | 1.6.6 DEBRAND | не задано | Токен аутентификации cloud tenant routes | Без значения маршруты с токен-аутентификацией отключены |
| `MYRMIDON_PROCESS_ROLE` | 1.6.6 DEBRAND | `all` | Роль процесса API, worker или совмещённого сервера | Без значения используется `all`; допустимы `all`, `worker`, `api` |
| `MYRMIDON_RUN_SCRATCH_DIR` | 1.6.6 DEBRAND | TMPDIR или системный временный каталог | Каталог временных SSH-файлов | Без значения используется TMPDIR, затем системный каталог |
| `MYRMIDON_SCRATCH_DIR` | 1.6.6 DEBRAND | резервный каталог в HOME | Разрешённый каталог файлов PKI site-agent | Без значения используется MYRMIDON_RUN_SCRATCH_DIR, затем HOME-каталог |
