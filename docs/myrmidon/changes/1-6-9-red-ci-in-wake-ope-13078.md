---
settings-section: Track 5 — operations
---

## changelog-en

### Red CI wake payload carries failed job names, ids, investigation command, and step log tails (OPE-13078)

When an engineer is woken by a red CI completion (`ci_completed` wake reason with failure or timed_out conclusion), the wake payload and assignment prompt now contain:
- the names of the failing jobs, their numeric check-run / job ids, and a ready-to-run investigation command (`gh run view <run> --job <job> --log-failed | tail -80`) with explicit instruction not to poll CI;
- the board-retrieved log tail (last 60 lines, ANSI stripped, secrets masked) for failing jobs (up to 3 jobs, capped at 12,000 characters total) when the board installation token has `actions:read` permission;
- a clear unavailable reason if log access is denied or unavailable.

The sanitizer patterns now mask tokens with `ghs_` and `github_pat_` prefixes along with existing secret formats.

## changelog-ru

### Побудка по красному CI несёт имена упавших заданий, id, команду расследования и хвост журнала шага (OPE-13078)

При побудке инженера по завершению CI с красным результатом (причина побудки `ci_completed` с заключением `failure` или `timed_out`) полезная нагрузка и текст задания теперь содержат:
- имена упавших заданий, их числовые идентификаторы (id) и готовую команду для расследования (`gh run view <run> --job <job> --log-failed | tail -80`) с явным указанием не опрашивать CI;
- хвост журнала упавшего шага (последние 60 строк, без ANSI-кодов, со скрытием секретов), полученный доской (до 3 заданий, суммарный лимит 12 000 символов), если токен установки доски имеет право `actions:read`;
- явную причину недоступности журнала, если доступ запрещён или лог недоступен.

В санитайзер секретов добавлены префиксы токенов `ghs_` и `github_pat_` наряду с существующими форматами секретов.
