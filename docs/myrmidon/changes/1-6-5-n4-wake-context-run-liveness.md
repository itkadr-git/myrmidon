---
divergence-section: Трек 2 — ядро побудок и прогонов
settings-section: Track 2 — wake and run core
---

## changelog-en

### Wake carries its task id; run liveness follows gateway events (N4)

- A wake whose task id reaches `heartbeatService.wakeup` only via
  `contextSnapshot.issueId` (for example the run-stall sweep's
  `issue_stalled_run`) is now stored and delivered with that id in the wake
  payload: the wake carries its task context to the agent, and every
  downstream consumer (wake payload renderer, coalescing key,
  execution-blocker check) sees the same `issueId`.
- Run liveness can follow gateway progress instead of the wall clock. With
  `MYRMIDON_RUN_LIVENESS_EVENTS=1` (default off) the hermes_gateway adapter
  replaces its fixed `timeoutSec` watchdog with a silence watch: a run that
  keeps emitting gateway events past its timeout is alive and is left alone,
  and only a run whose event stream has been silent for the whole budget is
  reported timed out. Per-agent opt-in via the card's «Liveness by gateway
  events» toggle. Off — the old fixed timeout, unchanged.

## changelog-ru

### Побудка несёт идентификатор задачи; живость прогона — по событиям шлюза (N4)

- Побудка, у которой идентификатор задачи доходит до
  `heartbeatService.wakeup` только через `contextSnapshot.issueId` (например,
  `issue_stalled_run` из run-stall-подметания), теперь хранится и
  доставляется с этим id в payload побудки: побудка несёт контекст задачи
  агенту, и все нижестоящие потребители (рендер payload побудки, ключ
  коалесцирования, проверка блокировки исполнения) видят один и тот же
  `issueId`.
- Живость прогона может следить за прогрессом шлюза, а не за настенными
  часами. При `MYRMIDON_RUN_LIVENESS_EVENTS=1` (по умолчанию выключено)
  адаптер hermes_gateway заменяет фиксированный сторож `timeoutSec` на
  наблюдение за тишиной: прогон, который продолжает выдавать события шлюза
  после своего таймаута, жив и не трогается, а по таймауту считается только
  прогон, чей поток событий молчал весь бюджет. Поштучный opt-in — тумблер
  «Liveness by gateway events» в карточке агента. Выкл — старый
  фиксированный таймаут, без изменений.

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| N4-WAKE-ISSUE-CONTEXT | В `enqueueWakeup` резолвнутый идентификатор задачи (`issueId`) зеркалируется в payload побудки, когда он пришёл только через `contextSnapshot.issueId`, а в payload его нет. Побудка тогда хранится и уезжает агенту со своим `issueId`; поведение побудок, у которых id уже есть в payload или которым задача не нужна, не меняется | `server/src/services/heartbeat.ts` (одна точка в `enqueueWakeup` после `enrichWakeContextSnapshot`; метка `myrmidon(N4-WAKE-ISSUE-CONTEXT)`) | Побудка run-stall-подметания (`issue_stalled_run`) несла задачу только в `contextSnapshot`; агентская побудка читается из payload, и задача до агента не доезжала. Тикет требует «побудка принимает контекст задачи» в одной точке — `heartbeatService.wakeup` | `server/src/__tests__/wake-issue-context.myrmidon.test.ts` (побудка только с `contextSnapshot.issueId` хранится с id в payload; явный `payload.issueId` сохраняется; побудка без задачи остаётся без `issueId`) | Никогда, наше поведение. Снятие: удалить блок `myrmidon(N4-WAKE-ISSUE-CONTEXT)` в `heartbeat.ts` и тест-файл | (этот PR) |
| N4-RUN-LIVENESS | В hermes_gateway фиксированный сторож `timeoutSec` заменяется наблюдением за тишиной по событиям шлюза: `ExecutionState.lastEventAtMs` штампуется каждым событием (`handleEvent`), а сторож раз в интервал проверяет, не превысила ли тишина бюджет; прогон со свежими событиями живёт дальше своего `timeoutSec` без ложного таймаута, молчащий весь бюджет — по таймауту. За `MYRMIDON_RUN_LIVENESS_EVENTS` (по умолчанию выкл) или тумблером карточки `livenessEvents`; выкл — вендорный фиксированный таймер, без изменений | `packages/adapters/hermes/src/gateway/server/execute.ts` (поле состояния, штамп в `handleEvent`, замена таймера на наблюдение за флагом; метка `myrmidon(N4-RUN-LIVENESS)`) + `packages/adapters/hermes/src/gateway/server/config-schema.ts` (поле карточки) + `packages/adapters/hermes/src/gateway/server/run-liveness-events.ts` (наш модуль) | Вендорский сторож — фиксированный таймер от старта `execute()`: прогон, который продолжает выдавать события шлюза после `timeoutSec`, срезается ровно как мёртвый. Тикет требует «живость прогона по событиям шлюза, ложных таймаутов нет» за выключаемой настройкой | `packages/adapters/hermes/src/gateway/server/run-liveness-events.myrmidon.test.ts` (разрешение флага и тумблера, сторож не стреляет при свежих событиях, стреляет при тишине длиннее бюджета, прогон без событий срезается ровно в бюджет, dispose глушит сторож) | Никогда, наше поведение. Снятие: удалить блоки `myrmidon(N4-RUN-LIVENESS)` из `execute.ts` и `config-schema.ts`, модуль `run-liveness-events.ts` и его тест | (этот PR) |

## settings-en

| `MYRMIDON_RUN_LIVENESS_EVENTS` | N4-RUN-LIVENESS | `0` | Run liveness follows gateway progress instead of the wall clock in the hermes_gateway adapter: on, the fixed `timeoutSec` watchdog is replaced by a silence watch — a run that keeps emitting gateway events past its timeout stays alive, and only a run silent for the whole budget is reported timed out | `1`/`true`/`on`/`yes` turn it on for every card; anything else or unset keeps the vendor's fixed timeout. The card toggle «Liveness by gateway events» overrides the env for its agent |

## settings-ru-append

<!-- section: Трек 2 — ядро побудок и прогонов -->
| `MYRMIDON_RUN_LIVENESS_EVENTS` | N4-RUN-LIVENESS | `0` | Живость прогона следует за прогрессом шлюза, а не за настенными часами в адаптере hermes_gateway: при включении фиксированный сторож `timeoutSec` заменяется наблюдением за тишиной — прогон, продолжающий выдавать события шлюза после таймаута, остаётся живым, а по таймауту считается только прогон, молчавший весь бюджет | `1`/`true`/`on`/`yes` включают для всех карточек; любое другое значение или отсутствие оставляют вендорский фиксированный таймаут. Тумблер карточки «Liveness by gateway events» перекрывает env для своего агента |
