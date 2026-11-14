---
settings-section: Track 5 — operations
---

## changelog-en

### Red CI wake payload carries failed job names, ids, investigation command, and step log tails (OPE-13078)

When an engineer is woken by a red CI completion (`ci_completed` wake reason with failure or timed_out conclusion), the wake payload and assignment prompt now contain:
- the names of the failing jobs, their numeric check-run / job ids, and a ready-to-run investigation command (`gh run view <run> --job <job> --log-failed | tail -80`);
- the board-retrieved log tail (last 60 lines, window ending at the last `##[error]` line when present, ANSI stripped, secrets masked) for failing jobs (up to 3 jobs fetched concurrently, capped at 12,000 characters total) when the board installation token has `actions:read` permission;
- a clear unavailable reason if log access is denied or unavailable.

The sanitizer now also masks `ghs_`/`github_pat_`/`gh[ousr]_` GitHub tokens, `sk-` API keys, `Authorization:` header values, passwords in URLs (`https://user:pass@host`), and AWS access key ids and secret keys, along with the existing formats. The "Do not poll CI: the failing output is below" line is printed only when at least one job has a log tail.

## changelog-ru

### Побудка по красному CI несёт имена упавших заданий, id, команду расследования и хвост журнала шага (OPE-13078)

При побудке инженера по завершению CI с красным результатом (причина побудки `ci_completed` с заключением `failure` или `timed_out`) полезная нагрузка и текст задания теперь содержат:
- имена упавших заданий, их числовые идентификаторы (id) и готовую команду для расследования (`gh run view <run> --job <job> --log-failed | tail -80`);
- хвост журнала упавшего шага (последние 60 строк, окно заканчивается на последней строке `##[error]`, если она есть, без ANSI-кодов, со скрытием секретов), полученный доской (до 3 заданий конкурентно, суммарный лимит 12 000 символов), если токен установки доски имеет право `actions:read`;
- явную причину недоступности журнала, если доступ запрещён или лог недоступен.

Санитайзер секретов теперь также скрывает токены GitHub `ghs_`/`github_pat_`/`gh[ousr]_`, ключи `sk-`, значения заголовка `Authorization:`, пароли в URL (`https://user:pass@host`), идентификаторы и секретные ключи AWS, наряду с прежними форматами. Строка «Do not poll CI: the failing output is below» выводится только если хотя бы у одного задания есть хвост журнала.
