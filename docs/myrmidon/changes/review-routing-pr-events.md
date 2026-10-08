---
divergence-section: REVIEW-ROUTING — автоназначение ревьюера задачам на ревью
settings-section: REVIEW-ROUTING: automatic reviewer for tasks in review
---

## changelog-en

### Review routing by pull-request events (REVIEW-ROUTING-PR-A)

- The review-routing sweep now also watches pull requests, so a review task is
  born the moment a PR turns green instead of waiting for the next manual
  "work through the PR queue" round. The shared `reviewRouting` settings gain a
  `prWatch` block (`enabled`, `repositories`, `maxOpenReviewsPerReviewer`,
  `maxNewAssignmentsPerPass`, `pollIntervalSec`, `steward.{enabled, roles,
  maxMergesPerSteward}`); every field absent or malformed falls back to its
  default without blanking the sibling keys, the same rule the outer block
  already follows.
- A pass resolves each open PR's head through GitHub (combined commit status —
  no statuses at all counts as green for repos without CI — plus the review
  decision derived from `GET /pulls/{n}/reviews`: latest verdict per reviewer on
  the current head; the REST PR object has no such field). The status read is
  cached per (repo, number, head sha) for 300 s, reviews are read fresh. A green head
  with no verdict on that exact head gets a review task assigned to the
  least-loaded eligible reviewer (board load and open PR-review load both
  capped, never the PR author's linked agent, never a non-invokable agent); an
  APPROVED green head additionally gets a merge-steward task for the
  least-loaded agent of the steward roles. Tasks are created through the normal
  issue path (activity log, checkout locks, review-stage machinery), carry a
  `pull_request` work product stamped with the head sha and the routing kind,
  and wake their assignee the same way board routing does.
- Pushing a new commit supersedes the open task of the same lane: it is
  cancelled with a system comment naming the new head, and the new head gets
  its own task on the same pass. Closed or merged PRs are left to PR-sync — the
  lane never settles them. When GitHub is unreadable the lane is inert: an
  unknown head creates nothing, closes nothing and counts no failure.
- New attention cards when nobody is eligible: `no_reviewer` for a green PR
  without a free reviewer, `no_steward` for an approved PR without a free
  steward, each carrying the PR coordinates (repository, number, head) for the
  settings screen and the attention desk. Activity actions
  `issue.review_routing.pr_task_created` and
  `issue.review_routing.steward_task_created` mark every created task, and the
  sweep result gains `prScanned`, `prTasksCreated`, `stewardTasksCreated` and
  `prSuperseded` counters.
- `pollIntervalSec` throttles only the PR lane; the board-task lane keeps its
  existing 60 s behavior, and a settings change applies on the next pass
  without a restart.

## changelog-ru

### Ручное→автомат: ревью по событиям пул-реквестов (REVIEW-ROUTING-PR-A)

- Sweep review-routing теперь следит и за pull request: задача-ревью рождается,
  как только PR стал зелёным, — вместо ожидания очередного ручного «разбора
  очереди PR». В общих настройках `reviewRouting` появляется блок `prWatch`
  (`enabled`, `repositories`, `maxOpenReviewsPerReviewer`,
  `maxNewAssignmentsPerPass`, `pollIntervalSec`, `steward.{enabled, roles,
  maxMergesPerSteward}`); отсутствующее или битое поле берёт default, не затирая
  соседей — то же правило, что уже действует для внешнего блока.
- Pass резолвит голову каждого открытого PR через GitHub (суммарный статус
  коммита — отсутствие статусов считается зелёным для репозиториев без CI, плюс
  агрегированный вердикт ревью), с кэшем на 300 с по (репо, номер, sha головы).
  Зелёная голова без вердикта именно на этой голове получает задачу-ревью
  наименее загруженного подходящего ревьюера (пороги и по досочной загрузке, и
  по открытым PR-ревью; автор PR как агент исключается, неинвуцируемые агенты
  не берутся); APPROVED-зелёная голова дополнительно получает задачу
  merge-стюарда наименее загруженному агенту стюард-ролей. Задачи создаются
  через обычный путь задач доски (журнал активности, лока, механика стадии
  ревью), несут work product `pull_request` со штампом головы и вида
  маршрутизации и будят исполнителя тем же способом, что и досочное ревью.
- Новый коммит вытесняет открытую задачу той же полосы: она отменяется с
  системным комментарием о новой голове, и новая голова получает свою задачу в
  том же проходе. Закрытые/слитые PR остаются TASK-PR-SYNC — полоса их не
  закрывает. При недоступном GitHub полоса инертна: unknown-голова не создаёт и
  не закрывает задач и не считается сбоем.
- Новые карточки внимания, когда исполнителя нет: `no_reviewer` для зелёного PR
  без свободного ревьюера и `no_steward` для одобренного PR без свободного
  стюарда — с координатами PR (репозиторий, номер, голова) для экрана настроек
  и стола внимания. Активности `issue.review_routing.pr_task_created` и
  `issue.review_routing.steward_task_created` помечают каждую созданную задачу,
  а результат sweep получает счётчики `prScanned`, `prTasksCreated`,
  `stewardTasksCreated`, `prSuperseded`.
- `pollIntervalSec` троттлит только PR-полосу; досочная полоса остаётся на
  своих 60 с, смена настроек применяется следующим pass без рестарта.

## divergence

| REVIEW-ROUTING-PR-A | Review routing gets a PR lane: the sweep polls open pull requests (webhook-fed `externalObjects` rows plus a per-repo `pulls?state=open` catch-up poll bounded by `pollIntervalSec`), resolves per-head CI/review verdict through a new GitHub resolver with a 300 s head-keyed cache, creates green-head review tasks and approved-head merge-steward tasks through `issueService.create` with a `pull_request` work product stamped `prRoutingHeadSha`/`prRoutingKind`, cancels tasks whose head was superseded, and raises `no_reviewer`/`no_steward` attention cards with PR coordinates. `prWatch` is additive to the frozen 1.6.2 `reviewRouting` contract; the existing task lane keeps its 60 s behavior | Вендор: `server/src/services/**` не отредактирован — новые файлы наши. Наши файлы: `packages/shared/src/myrmidon-review-routing.ts` (+`.test.ts`), `server/src/myrmidon/review-routing/{pr-policy,github,github.myrmidon,policy,policy.myrmidon,attention,sweep,sweep.myrmidon,store,index}.ts` | Standing "share of the PR queue" tickets block themselves when empty and reviews lag pushes by hours; routing by PR event closes the operator incident of 06.10 (4 of 7 share tickets blocked while 30 PRs waited) | `packages/shared/src/myrmidon-review-routing.test.ts`, `server/src/myrmidon/review-routing/policy.myrmidon.test.ts` (triggers, ceilings, author exclusion, patch shape), `server/src/myrmidon/review-routing/sweep.myrmidon.test.ts` (fake store + fake resolver: first-green create, coverage no-op, APPROVED steward, supersede, resolver failure inertness, throttle), `server/src/myrmidon/review-routing/github.myrmidon.test.ts` (status parsing, decision from the reviews list, cache, outage → unknown) | When the vendor ships PR-event routing itself: delete `pr-policy.ts`, `github.ts`, the PR-lane branch of `sweep.ts`/`store.ts`, the `prWatch` block of the shared contract, and the PR rows in the registry docs; `packages/shared/src/index.ts` re-exports the whole module so no wiring file changes | (этот PR) |

## settings-en-append

<!-- section: REVIEW-ROUTING: automatic reviewer for tasks in review -->

PR lane (REVIEW-ROUTING-PR). The fields live under `prWatch` in the same
`instance_settings.general.reviewRouting` document, on the same settings screen;
`pollIntervalSec` gates only the PR lane (the task lane stays at 60 s). Absent
or malformed `prWatch` — or any field of it — falls back to the defaults below
without blanking the sibling keys.

| Field | Default | What it does | How to disable / special |
|---|---|---|---|
| `prWatch.enabled` | `true` | Switches the PR lane of the sweep: open pull requests get review/merge-steward tasks by head state | `false` — the lane creates nothing and its attention cards disappear; the task lane is untouched |
| `prWatch.repositories` | `[]` | `"owner/repo"` entries (max 20, each ≤ 200 chars, owner/repo shape) whose open PRs are polled at most once per `pollIntervalSec` per repo — catches PRs opened while the board was down. Webhook-fed PRs are routed regardless of this list | `[]` — no catch-up polling; only PRs already seen via the connector (or work products) are polled. Invalid entries are dropped to `[]` |
| `prWatch.maxOpenReviewsPerReviewer` | `3` | A reviewer holding this many OPEN pr-review tasks is not picked (on top of `maxLoadPerReviewer` for board load; both gates apply). From 1 to 100 | — |
| `prWatch.maxNewAssignmentsPerPass` | `5` | Review+steward tasks this lane may create per pass; the rest wait for the next pass. From 1 to 50 | — |
| `prWatch.pollIntervalSec` | `60` | Minimum spacing of PR-lane passes (head resolution and catch-up polling). From 15 to 3600 | — |
| `prWatch.steward.enabled` | `true` | Approved (and green) heads get a merge-steward task | `false` — no steward tasks; review tasks keep working |
| `prWatch.steward.roles` | `["devops"]` | Caste keys whose invokable agents are eligible as merge stewards | An empty list — every approved PR is signalled `no_steward` |
| `prWatch.steward.maxMergesPerSteward` | `3` | A steward holding this many OPEN merge tasks is not picked. From 1 to 50 | — |

## settings-ru-append

<!-- section: REVIEW-ROUTING: автоназначение ревьюера задачам на ревью -->

PR-полоса (REVIEW-ROUTING-PR). Поля живут в блоке `prWatch` того же документа
`instance_settings.general.reviewRouting` на том же экране настроек;
`pollIntervalSec` троттлит только PR-полосу (досочная полоса остаётся на 60 с).
Отсутствующий или битый `prWatch` — или любое его поле — берёт defaults ниже,
не затирая соседние ключи.

| Поле | Default | Что делает | Как выключить / особенности |
|---|---|---|---|
| `prWatch.enabled` | `true` | Выключатель PR-полосы sweep: открытые pull request получают задачи ревью и merge-стюарда по состоянию головы | `false` — полоса ничего не создаёт, её карточки внимания исчезают; досочная полоса не затронута |
| `prWatch.repositories` | `[]` | Записи `"owner/repo"` (до 20, каждая ≤ 200 символов, формат owner/repo), чьи открытые PR опрашиваются не чаще раза в `pollIntervalSec` на репозиторий — догоняют PR, открытые, пока доска стояла. PR из вебхука коннектора маршрутизируются независимо от списка | `[]` — догоняющего опроса нет; опрашиваются только PR, уже видимые через коннектор (или work products). Некорректные записи отбрасываются к `[]` |
| `prWatch.maxOpenReviewsPerReviewer` | `3` | Ревьюер с таким числом ОТКРЫТЫХ pr-review задач не выбирается (помимо `maxLoadPerReviewer` по досочной загрузке; оба порога действуют). От 1 до 100 | — |
| `prWatch.maxNewAssignmentsPerPass` | `5` | Задач ревью+стюарда, которые полоса создаст за pass; остальные ждут следующего. От 1 до 50 | — |
| `prWatch.pollIntervalSec` | `60` | Минимальный интервал PR-полосы (резолв голов и догоняющий опрос). От 15 до 3600 | — |
| `prWatch.steward.enabled` | `true` | Одобренные (и зелёные) головы получают задачу merge-стюарда | `false` — задач стюарда нет; задачи ревью работают |
| `prWatch.steward.roles` | `["devops"]` | Касты, чьи инвуцируемые агенты подходят как merge-стюарды | Пустой список — каждый одобренный PR получает карточку `no_steward` |
| `prWatch.steward.maxMergesPerSteward` | `3` | Стюард с таким числом ОТКРЫТЫХ merge-задач не выбирается. От 1 до 50 | — |
