## changelog-en

### Reason refs on internal blocked paths (1.6.1 STALE-BLOCK follow-up)

- The service paths that enter `blocked` without going through the public
  PATCH route — native-failure reconciliation, the native finalizer's
  ambiguous-state block, recovery escalation of stranded and disposition-repair
  issues, the native blocked-wait repair, the unrunnable-workspace dispatch
  block, and the LLM Wiki maintainer blocks — now write the part A reason
  contract (`unblockDescriptor.reasonRef`) too. Recovery-driven paths cite the
  event key `recovery.liveness:<issueId>`; the stale-block sweep resolves that
  key against the live `issue_recovery_actions` rows, so a recovery block whose
  incident is explicitly resolved or cancelled is swept instead of staying an
  unknown, never-swept reason.
- The sweep's event reader is wired in the server entry
  (`createRecoveryLivenessEventReader`); any other event key keeps the
  documented still-set default, so an unwired gate never silently unblocks a
  task. The plugin SDK `issues.update` patch gained the additive
  `unblockDescriptor` field so plugins can carry the same contract.

## changelog-ru

### Причина-ссылка на внутренних путях blocked (1.6.1 STALE-BLOCK, follow-up)

- Сервисные пути, которые входят в `blocked`, минуя публичный PATCH-роут —
  реконсиляция нативного сбоя, блок неоднозначного состояния финализера,
  эскалация зависших recovery-задач и задач repair-диспозиции, ремонт
  нативного ожидания, блок невыполнимой конфигурации workspace и блоки
  LLM Wiki — теперь тоже пишут контракт части A (`unblockDescriptor.reasonRef`).
  Recovery-пути ссылаются на событие `recovery.liveness:<issueId>`; сторож
  разрешает этот ключ по живым строкам `issue_recovery_actions`, поэтому блок,
  чей инцидент явно закрыт (resolved/cancelled), снимается, а не остаётся
  «неизвестной причиной».
- Резолвер событий сторожа подключён в серверном входе
  (`createRecoveryLivenessEventReader`); остальные ключи сохраняют
  документированное значение «ещё установлен», поэтому незакрытый gate никогда
  не снимает блок молча. Патч `issues.update` в plugin SDK получил аддитивное
  поле `unblockDescriptor` — плагины могут нести тот же контракт.
