---
settings-section: Track 5 — operations
---

## changelog-en

### The review-return loop pace is a setting, and its pass spends one read per pull request (OPE-12397)

The review-return (rework) loop swept every minute and re-read the pull request of every
candidate review task on every pass — up to 200 tasks, no deduplication between tasks that
share one pull request, terminal pull requests included, and every process of the
installation swept on its own. Together with the other GitHub readers this drained the
App's budget of 5000 requests per hour. The loop now:

- paces by the stored instance setting `sweepIntervalSec` (default 300 s, range 60–3600,
  the Review Rework panel edits it, saving applies without a restart);
- `MYRMIDON_REVIEW_REWORK_SWEEP_INTERVAL_SEC` overrides the stored value as the
  deployment fallback (the panel shows the override read-only, the LiteLlm budget-sync
  rule);
- reads each pull request at most once per pass: two review tasks linked to the same
  pull request cost one read, a task naming the same pull request twice costs one;
- skips candidates that cannot produce a move before any GitHub read: no rework child,
  no verdict keyword, and no live (non-terminal) pull-request work product;
- runs only on the "scheduler" leader process — the same leadership gate TASK-PR-SYNC
  uses — so secondary processes stop re-reading every candidate's pull requests.

Run-start context no longer refreshes pull-request metadata from GitHub: `loadRunPullRequest`
reads the stored work-product metadata (`headRef`, `repo` are already there), and the
wake-payload CI resolver reads only live (non-terminal) pull-request products of the task,
at most 10 references per build. GitHub reads are attributed per reader in the
`[github-rate-limit]` log: `review-rework`, `review-routing`, `run-context`, `ui-refresh`
join the existing buckets, and `review-routing` counts and honours the limit as the other
readers do.

## changelog-ru

### Темп цикла возвратов ревью — настройка, а проход тратит один запрос на пулл-реквест (OPE-12397)

Цикл возвратов ревью (rework) обходил кандидатов раз в минуту и на каждом проходе
перечитывал пулл-реквест каждой задачи-кандидата — до 200 задач, без дедупликации между
задачами с одним пулл-реквестом, включая терминальные пулл-реквесты, и каждый процесс
установки обходил сам по себе. Вместе с остальными читателями GitHub это расходовало
лимит установки App (5000 запросов в час). Теперь цикл:

- задаёт темп сохранённой настройкой экземпляра `sweepIntervalSec` (по умолчанию 300 с,
  диапазон 60–3600, правится в панели Review Rework, сохранение действует без
  перезапуска);
- `MYRMIDON_REVIEW_REWORK_SWEEP_INTERVAL_SEC` перекрывает сохранённое значение как
  резерв развёртывания (панель показывает override только для чтения, как у budget-sync
  LiteLlm);
- читает каждый пулл-реквест не больше одного раза за проход: две задачи ревью с одним
  пулл-реквестом — один запрос, дважды названный в задаче — тоже один;
- пропускает кандидатов, которые не могут дать перемещение, до любого запроса в GitHub:
  нет rework-ребёнка, нет вердикта и нет живого (не терминального) PR-продукта;
- работает только на процессе-лидере "scheduler" — тот же барьер лидерства, что у
  TASK-PR-SYNC, — поэтому вторичные процессы перестают перечитывать пулл-реквесты всех
  кандидатов.

Стартовый контекст прогона больше не обновляет метаданные пулл-реквестов в GitHub:
`loadRunPullRequest` читает сохранённые метаданные продукта (`headRef` и `repo` уже
там), а CI-резолвер wake-нагрузки читает только живые (не терминальные) PR-продукты
задачи, не больше 10 ссылок на сборку. Запросы к GitHub разносятся по читателям в
журнале `[github-rate-limit]`: `review-rework`, `review-routing`, `run-context`,
`ui-refresh` пополняют существующие корзины, а `review-routing` учитывается и уважает
лимит наравне с остальными.

## settings-en

| `MYRMIDON_REVIEW_REWORK_SWEEP_INTERVAL_SEC` | OPE-12397 | not set (stored `sweepIntervalSec`, default 300) | Deployment fallback for the review-return loop pass interval, seconds (60–3600); a set value overrides the stored setting and the panel shows it read-only | unset the variable to return control to the Review Rework panel |

## settings-ru

| `MYRMIDON_REVIEW_REWORK_SWEEP_INTERVAL_SEC` | OPE-12397 | не задан (сохранённая `sweepIntervalSec`, по умолчанию 300) | Резерв развёртывания для интервала прохода цикла возвратов ревью, секунды (60–3600); заданное значение перекрывает сохранённую настройку, панель показывает его только для чтения | снять переменную, чтобы вернуть управление панели Review Rework |
