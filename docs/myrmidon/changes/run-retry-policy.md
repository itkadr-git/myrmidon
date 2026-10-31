---
divergence-section: Трек 2 — ядро побудок и прогонов
settings-section: Track 2 — wake and run core
---

## changelog-en

### Automatic retry of a failed run is one policy: failure class, exponential backoff, attempt limit, counter in the UI (1.6.6 RUN-RETRY-POLICY)

- A failed run is now classified before it is queued again. The classification
is `transient`, `permanent` or `unknown`, and it decides whether a retry is
queued at all: a transient failure is worth another attempt, a permanent one is
never retried automatically, an unclassified one keeps the historical
single-attempt treatment (the board has no evidence that repeating it would
help).
- The transient/permanent taxonomy and the attempt ceilings moved into one
module, `server/src/myrmidon/run-retry-policy`, which is now the only place that
answers those questions. The list of codes is unchanged: the six transient codes
(`adapter_failed`, `codex_transient_upstream`, `codex_harness_crash`,
`claude_transient_upstream`, `provider_quota`, `timeout`) and the eighteen
permanent ones (`setup_failed`, the five `workspace_git_scan_*` codes, the
`low_trust_*` family, `budget_*`, `issue_*`, `agent_not_invokable`,
`agent_not_found`, `adapter_engine_unavailable`) earn exactly the same verdict
they earned before, and the defaults reproduce the numbers the paths used
(bounded retry: 3 attempts; unclassified: 1; backoff base: 60 s, factor 2).
- The adapter's own verdict is consulted as one more signal: a run whose
persisted `errorFamily` is `transient_upstream` or `provider_quota` is treated
as transient even when its error code is generic, and one whose family is
`permanent_config_error`, `model_refusal`, `refresh_token_reused` or
`refresh_token_invalidated` is permanent — no repeated attempt against a
configuration or credential problem that cannot heal by itself.
- The backoff is exponential and censored: `base · multiplier^(attempt − 1)`,
capped by a ceiling, optionally jittered symmetrically, never below one second.
An operator can now reach the ceiling (`MYRMIDON_RUN_RETRY_MAX_DELAY_SEC`) and
the jitter (`MYRMIDON_RUN_RETRY_JITTER_PERCENT`) without a code change; with the
defaults the schedule is bit-for-bit the one the board produced before.
- The board shows the counter: the scheduled-retry card and the task properties
render "Attempt 2 of 3 · Transient failure" — how many attempts the scheduler
allowed and what kind of failure is behind the retry. A retry queued before this
change (no snapshot in the run context) keeps the bare "Attempt 2".
- This is not the stall path: RUN-STALL/F-26 interrupts a run that is still
*running* without progress. This policy is about a run that already *failed* and
about the retry the board queues for it, and it never touches a live run.

## changelog-ru

### Автоповтор упавшего прогона — одна политика: класс ошибки, экспоненциальный бэкофф, лимит попыток, счётчик в интерфейсе (1.6.6 RUN-RETRY-POLICY)

- Упавший прогон теперь классифицируется до того, как его поставят в очередь
снова. Класс — `transient`, `permanent` или `unknown`, и он решает, будет ли
повтор вообще: временная ошибка заслуживает ещё одной попытки, постоянная не
повторяется автоматически никогда, неклассифицированная сохраняет прежнее
поведение (одна попытка — доски не имеют доказательств, что повтор поможет).
- Таксономия временное/постоянное и лимиты попыток переехали в один модуль —
`server/src/myrmidon/run-retry-policy` — и он теперь единственное место, где на
эти вопросы отвечают. Список кодов не изменился: шесть временных
(`adapter_failed`, `codex_transient_upstream`, `codex_harness_crash`,
`claude_transient_upstream`, `provider_quota`, `timeout`) и восемнадцать
постоянных (`setup_failed`, пять `workspace_git_scan_*`, семейство
`low_trust_*`, `budget_*`, `issue_*`, `agent_not_invokable`, `agent_not_found`,
`adapter_engine_unavailable`) получают ровно тот же вердикт, что и раньше, а
умолчания воспроизводят прежние числа (3 попытки, для неклассифицированной —
1, база бэкоффа 60 с, множитель 2).
- Вердикт адаптера учитывается как дополнительный сигнал: прогон, у которого в
`errorFamily` записано `transient_upstream` или `provider_quota`, считается
временным даже при общем коде ошибки, а `permanent_config_error`,
`model_refusal`, `refresh_token_reused`, `refresh_token_invalidated` —
постоянным: повторять попытку против ошибки конфигурации или учётных данных,
которая сама не вылечится, бессмысленно.
- Бэкофф экспоненциальный и ограниченный: `база · множитель^(попытка − 1)`, но
не больше потолка, с необязательным симметричным джиттером и не меньше одной
секунды. Потолок (`MYRMIDON_RUN_RETRY_MAX_DELAY_SEC`) и джиттер
(`MYRMIDON_RUN_RETRY_JITTER_PERCENT`) теперь доступны оператору без правки кода;
на умолчаниях расписание совпадает с тем, что доска выдавала раньше.
- Доска показывает счётчик: карточка запланированного повтора и свойства задачи
рисуют «Attempt 2 of 3 · Transient failure» — сколько попыток разрешил
планировщик и какого класса ошибка за повтором. Повтор, поставленный до этого
изменения (снимка в контексте прогона нет), остаётся с прежним «Attempt 2».
- Это не путь остановки: RUN-STALL/F-26 прерывает прогон, который ещё *идёт* без
прогресса. Эта политика — про прогон, который уже *упал*, и про повтор для него,
и она никогда не трогает живой прогон.

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| RUN-RETRY-POLICY | Решение «повторять ли упавший прогон» сводится в один модуль `server/src/myrmidon/run-retry-policy`: классификация ошибки (`transient`/`permanent`/`unknown` — по коду ошибки и по `errorFamily` адаптера), экспоненциальный бэкофф с потолком и джиттером, лимит попыток и снапшот решения в контексте прогона. `classifyContinuationFailure` в `server/src/services/recovery/service.ts` больше не держит свои наборы кодов и числа — он спрашивает модуль, поэтому вердикт для всех существующих кодов прежний, а семейство адаптера становится ещё одним сигналом. Проверка «распутать застрявшее продолжение» считает паузу тем же бэкоффом, а не своей формулой. Планировщик повтора (`scheduleBoundedRetryForRun`) записывает в контекст прогона снимок решения `retryPolicy`, из которого API отдаёт счётчик «попытка N из M» и класс ошибки в UI | `server/src/services/recovery/service.ts` (делегирование классификации, бэкофф `computeRunRetryBackoff`; метка `myrmidon(1.6.6 RUN-RETRY-POLICY)`), `server/src/services/heartbeat.ts` (снимок `retryPolicy` в контекст повтора, поля `scheduledRetryMaxAttempts`/`scheduledRetryClassification` в сводке), `server/src/routes/issues.ts` (проброс сводки), `packages/shared/src/types/issue.ts`, `ui/src/lib/runRetryState.ts`, `ui/src/components/IssueScheduledRetryCard.tsx`, `ui/src/components/issue-properties/IssueProperties.tsx` | Тикет OPE-6881 требует политику автоповтора упавших прогонов. До этого «повторять или нет» решалось в нескольких местах сразу (свой набор кодов в recovery, своя формула паузы в проверке застрявшего продолжения, отдельные лимиты в планировщике), а счётчика попыток в UI не было вовсе — оператор видел номер попытки без предела | `server/src/myrmidon/run-retry-policy/classification.myrmidon.test.ts` (таблица кодов и семейств, приоритет постоянного вердикта, неизвестный и пустой код, пересечение наборов), `server/src/myrmidon/run-retry-policy/policy.myrmidon.test.ts` (умолчания воспроизводят прежние числа, рост и потолок бэкоффа, джиттер в границах, лимит попыток, выключение политики, снимок решения), `server/src/services/recovery/provider-failure-classification.test.ts` (вердикты существующих кодов не изменились), `server/src/__tests__/heartbeat-retry-scheduling.test.ts` (повтор по-прежнему ставится и несёт прежний контекст), `ui/src/lib/runRetryState.test.ts` и `ui/src/components/IssueScheduledRetryCard.test.tsx` (счётчик с пределом и класс, старые повторы без снимка) | Никогда, наше поведение. Снятие: удалить каталог `server/src/myrmidon/run-retry-policy/`, вернуть наборы кодов и числа в `classifyContinuationFailure`, вернуть формулу паузы в проверку застрявшего продолжения, убрать снимок `retryPolicy` из `scheduleBoundedRetryForRun` и поля `scheduledRetryMaxAttempts`/`scheduledRetryClassification` из сводки, типов, UI и тестов | (этот PR) |

## settings-en

| `MYRMIDON_RUN_RETRY_ENABLED` | RUN-RETRY-POLICY | `true` | Master switch of the automatic retry of a failed run: with `false` the policy never queues another attempt, and a failure the recovery path would have retried is left for a human | `false` — no automatic retry of a failed run |
| `MYRMIDON_RUN_RETRY_MAX_ATTEMPTS` | RUN-RETRY-POLICY | `3` | How many attempts a *transient* failure of issue continuation is worth, and the ceiling the board shows when a retry schedule carries none of its own. Same value the continuation path used before the policy existed | `1` — one attempt, no repetition; `0` — never retry a transient failure |
| `MYRMIDON_RUN_RETRY_UNKNOWN_MAX_ATTEMPTS` | RUN-RETRY-POLICY | `1` | How many attempts a failure the policy cannot classify is worth. Default keeps the historical treatment: an unclassified failure is not repeated | `0` — an unclassified failure is never retried |
| `MYRMIDON_RUN_RETRY_BASE_DELAY_SEC` | RUN-RETRY-POLICY | `60` | Delay of the first retry and the base of the exponential backoff, in seconds. Allowed range `1`–`86400`; `0`, a negative value or a typo fall back to the default, so the shortest wait the policy can be asked for is one second | — (the delay is what the policy is for) |
| `MYRMIDON_RUN_RETRY_MULTIPLIER` | RUN-RETRY-POLICY | `2` | Growth of the delay per attempt: `delay(n) = base · multiplier^(n−1)` | `1` — constant delay between attempts |
| `MYRMIDON_RUN_RETRY_MAX_DELAY_SEC` | RUN-RETRY-POLICY | `1800` | Ceiling of the exponential backoff, in seconds: once the computed delay passes it, every attempt waits exactly this long | — (raise it to keep the growth, lower it to flatten the tail) |
| `MYRMIDON_RUN_RETRY_JITTER_PERCENT` | RUN-RETRY-POLICY | `0` | Symmetric jitter in percent applied to the computed delay (`±N%`), so many runs that failed together do not retry together | `0` — no jitter, exactly the computed delay |

## settings-ru

| `MYRMIDON_RUN_RETRY_ENABLED` | RUN-RETRY-POLICY | `true` | Главный выключатель автоповтора упавшего прогона: при `false` политика не ставит ни одной попытки, а ошибка, которую путь восстановления повторил бы, остаётся человеку | `false` — автоповтора упавшего прогона нет |
| `MYRMIDON_RUN_RETRY_MAX_ATTEMPTS` | RUN-RETRY-POLICY | `3` | Сколько попыток стоит *временная* ошибка продолжения задачи и какой предел доска показывает, когда у расписания повтора своего предела нет. То же число, что путь продолжения использовал до появления политики | `1` — одна попытка, без повтора; `0` — временную ошибку не повторять никогда |
| `MYRMIDON_RUN_RETRY_UNKNOWN_MAX_ATTEMPTS` | RUN-RETRY-POLICY | `1` | Сколько попыток стоит ошибка, которую политика не смогла классифицировать. Умолчание сохраняет прежнее поведение: неклассифицированная ошибка не повторяется | `0` — неклассифицированную ошибку не повторять |
| `MYRMIDON_RUN_RETRY_BASE_DELAY_SEC` | RUN-RETRY-POLICY | `60` | Задержка первой попытки и база экспоненциального бэкоффа в секундах. Допустимый диапазон `1`–`86400`; `0`, отрицательное значение или опечатка откатываются к умолчанию, поэтому самая короткая задержка, которую можно задать политике, — одна секунда | — (задержка и есть смысл политики) |
| `MYRMIDON_RUN_RETRY_MULTIPLIER` | RUN-RETRY-POLICY | `2` | Рост задержки с каждой попыткой: `задержка(n) = база · множитель^(n−1)` | `1` — постоянная задержка между попытками |
| `MYRMIDON_RUN_RETRY_MAX_DELAY_SEC` | RUN-RETRY-POLICY | `1800` | Потолок экспоненциального бэкоффа в секундах: как только расчётная задержка его превышает, каждая попытка ждёт ровно столько | — (поднять, чтобы рост продолжался; опустить, чтобы срезать хвост) |
| `MYRMIDON_RUN_RETRY_JITTER_PERCENT` | RUN-RETRY-POLICY | `0` | Симметричный джиттер в процентах к расчётной задержке (`±N%`), чтобы много прогонов, упавших вместе, не повторялись вместе | `0` — без джиттера, ровно расчётная задержка |