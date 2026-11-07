---
settings-section: Track 5 — operations
---

## changelog-en

### A review return on the same pull request head, or only on infrastructure checks, no longer wakes the executor (REVIEW-RETURN-GUARD, OPE-11970)

- One engineer bot was woken 199 times in four days with `execution_changes_requested` (520M input tokens, almost all on
  four tasks). The reviewer returned the task because CI of the pull request head was red only on flaky or infrastructure
  checks, or returned it again on the same head; the executor had no commit to make, resubmitted, and the loop went on.
- The execution state now remembers the head of the pull request at the last return (`lastChangesRequestedHeadSha`).
  When an agent reviewer returns the task on that same head again, with no new commit in between, the decision is recorded
  as before and the executor stays assigned, but it is not woken. A system note says so in the task thread, and the
  activity row `issue.review_return_wake_suppressed` is written.
- When the decision comment reports only CI (it mentions CI and cites no file, line or code block) and every check that
  failed on the head is on the infrastructure list (`CI result` failing alone is its own queue-latency gate, `main-green`
  fails while main is red), the executor is not woken either, and the activity row `issue.ci_infra_retry_needed` tells
  the release tooling to re-run the failed jobs. The list is `MYRMIDON_REVIEW_INFRA_CHECK_NAMES`.
- The executor is still woken by a new CI result on the head (`ci_completed`), by a comment and by a new head. A human
  reviewer is never held back. Anything the guard cannot read (GitHub error, unknown head, a lane of the code failed)
  keeps the old behaviour.
- Reviewer rules (skill `engineering-discipline`): a verdict is about the code; wait while CI runs; re-run the failed jobs
  once when CI is red only on known flaky or infrastructure checks; never repeat REQUEST CHANGES on the same head without
  new findings in the code.

## changelog-ru

### Возврат ревью на той же голове PR или только из-за инфраструктурных проверок больше не будит исполнителя (REVIEW-RETURN-GUARD, OPE-11970)

- Один бот-инженер за четыре дня получил 199 побудок `execution_changes_requested` (520M входных токенов, почти все — на
  четырёх задачах). Ревьюер возвращал задачу, потому что CI на голове PR был красным только на нестабильных или
  инфраструктурных проверках, или возвращал её повторно на той же голове; исполнителю нечего было коммитить, он сдавал
  задачу заново, и круг повторялся.
- Состояние исполнения теперь помнит голову PR при последнем возврате (`lastChangesRequestedHeadSha`). Когда
  ревьюер-агент возвращает задачу на той же голове ещё раз, без нового коммита, решение записывается как раньше, исполнитель
  остаётся назначенным, но не будится. В задаче появляется системная пометка, пишется строка активности
  `issue.review_return_wake_suppressed`.
- Если комментарий решения говорит только о CI (упоминает CI и не ссылается на файл, строку или блок кода), а все
  упавшие на голове проверки входят в список инфраструктурных (`CI result`, упавший один, — это собственный гейт задержки
  очереди; `main-green` падает, пока main красный), исполнитель тоже не будится, а строка активности
  `issue.ci_infra_retry_needed` сообщает автоматике выпуска, что нужно перезапустить упавшие джобы. Список задаётся
  переменной `MYRMIDON_REVIEW_INFRA_CHECK_NAMES`.
- Исполнителя по-прежнему будят новый результат CI на голове (`ci_completed`), комментарий и новая голова. Ревьюера-человека
  защита не сдерживает. Всё, что защита не смогла прочитать (ошибка GitHub, неизвестная голова, упала проверка кода),
  оставляет прежнее поведение.
- Правила ревьюера (навык `engineering-discipline`): вердикт — про код; пока CI идёт, жди; при красном CI только на
  известных нестабильных или инфраструктурных проверках один раз перезапусти упавшие джобы; не повторяй REQUEST CHANGES на
  той же голове без новых замечаний к коду.

## settings-en

| `MYRMIDON_REVIEW_RETURN_GUARD_ENABLED` | REVIEW-RETURN-GUARD | unset (on) | An agent reviewer's return of a task (`changes_requested`) on the same pull request head as the previous return, or only because infrastructure checks of the head failed, is recorded but does not wake the executor. The rest of the board (a new CI result, a comment, a new head) still does | `off`, `0`, `false` or `no` brings back a wake for every return. Read on every review decision |
| `MYRMIDON_REVIEW_INFRA_CHECK_NAMES` | REVIEW-RETURN-GUARD | `CI result,main-green` | Comma or newline separated names of the checks whose failure does not say anything about the code (whole names, case-insensitive). A return is infrastructure-only when every check that failed on the head is on this list and the decision comment reports only CI | An empty value leaves no infrastructure check: only the same-head rule works. Read on every review decision |

## settings-ru

| `MYRMIDON_REVIEW_RETURN_GUARD_ENABLED` | REVIEW-RETURN-GUARD | не задано (включено) | Возврат задачи ревьюером-агентом (`changes_requested`) на той же голове PR, что и предыдущий возврат, или только из-за упавших инфраструктурных проверок головы записывается, но не будит исполнителя. Остальные побудки доски (новый результат CI, комментарий, новая голова) работают | `off`, `0`, `false` или `no` возвращает побудку на каждый возврат. Читается при каждом решении ревью |
| `MYRMIDON_REVIEW_INFRA_CHECK_NAMES` | REVIEW-RETURN-GUARD | `CI result,main-green` | Имена проверок через запятую или с новой строки, падение которых ничего не говорит о коде (имя целиком, без учёта регистра). Возврат считается инфраструктурным, когда все упавшие на голове проверки входят в этот список, а комментарий решения говорит только о CI | Пустое значение — ни одной инфраструктурной проверки: работает только правило «та же голова». Читается при каждом решении ревью |
