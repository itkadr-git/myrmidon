---
settings-section: Track 5 — operations
---

## changelog-en

### The board reports an approved pull request stuck BLOCKED and records GitHub's merge refusal (OPE-13136)

When an approved pull request stays `BLOCKED` on GitHub for longer than a threshold although the review marker is on it and the required checks are green (for example a required check left "expected" by a workflow), the board now writes one `issue.review_routing.board_merge_blocked` activity record on the task and one warning in the server log. The record names the repository, pull request number, head, minutes blocked and required checks, and is not repeated for the same head; a new head or a pull request that is no longer blocked starts the count over. The threshold is the new `boardMerge.blockedAlertAfterMinutes` review-routing setting (default 30, `0` switches the alert off, maximum 1440).

When GitHub refuses the board's merge call (HTTP 405 / 422), the board now records an `issue.review_routing.board_merge_refused` activity on the task with the HTTP status and GitHub's own message, at most once per hour per pull request.

## changelog-ru

### Доска сообщает о одобренном PR, застрявшем в BLOCKED, и записывает отказ GitHub при слиянии (OPE-13136)

Если одобренный pull request дольше порога остаётся в состоянии `BLOCKED` на GitHub, хотя на нём стоит метка ревью и обязательные проверки зелёные (например, workflow оставил обязательную проверку в состоянии «expected»), доска теперь пишет на задачу одну запись активности `issue.review_routing.board_merge_blocked` и одно предупреждение в журнал сервера. В записи — репозиторий, номер PR, голова, сколько минут заблокирован и обязательные проверки; для той же головы запись не повторяется, а новая голова или снятая блокировка начинают отсчёт заново. Порог — новая настройка маршрутизации ревью `boardMerge.blockedAlertAfterMinutes` (по умолчанию 30, `0` отключает оповещение, максимум 1440).

Если GitHub отказывает в вызове слияния доски (HTTP 405 / 422), доска теперь пишет на задачу запись активности `issue.review_routing.board_merge_refused` с HTTP-статусом и собственным сообщением GitHub, не чаще раза в час на один PR.
