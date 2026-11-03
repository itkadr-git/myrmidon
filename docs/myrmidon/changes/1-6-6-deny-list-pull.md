---
divergence-section: Трек 1 — платформа
---

## changelog-en

### The installation pulls the issuer's signed deny-list itself (OPE-9084, 1.6.6)

- The board now periodically fetches the signed `license.deny.json` from the URL in
  `MYR_LICENSE_DENY_URL` (default interval 60s, override via `MYR_LICENSE_DENY_PULL_INTERVAL_MS`,
  minimum 1s). The manual admin `POST /api/licensing/deny-list` remains for offline installs.
- Each pull verifies the Ed25519 signature against the trusted issuer keys, enforces the
  monotonic serial rule (a lower serial is rejected and logged, the file stays untouched),
  and replaces the file next to `license.key` atomically (temp file + rename, 0644).
- The puller holds no private key and never serves the list; it only downloads, verifies and
  installs it. No URL configured -> the puller stays idle and starts no timer.
- Timer lifecycle: started with the app's background work, stopped on the shutdown hook
  (`app.locals.paperclipShutdown`), `unref`'d so it never keeps the process alive.

## changelog-ru

### Установка сама забирает подписанный список отзыва у issuer (OPE-9084, 1.6.6)

- Доска периодически скачивает подписанный `license.deny.json` по URL из
  `MYR_LICENSE_DENY_URL` (интервал по умолчанию 60 с, переопределяется
  `MYR_LICENSE_DENY_PULL_INTERVAL_MS`, минимум 1 с). Ручной `POST /api/licensing/deny-list`
  остаётся для оффлайн-установок.
- Каждый pull проверяет подпись Ed25519 по доверенным ключам issuer, соблюдает монотонность
  serial (меньший serial отклоняется с записью в лог, файл не меняется) и атомарно заменяет
  файл рядом с `license.key` (временный файл + rename, 0644).
- Puller не держит закрытый ключ и не выдаёт список; он только скачивает, проверяет и
  устанавливает его. URL не задан -> puller простаивает и не запускает таймер.
- Жизненный цикл таймера: стартует вместе с фоновой работой приложения, останавливается в
  shutdown-хуке (`app.locals.paperclipShutdown`), `unref` — процесс не держит.
