---
---

## changelog-en

### Wake diagnostics report real engine reasons instead of `other` (OPE-2769)

- `GET /api/issues/{id}/diagnostics/wakes` no longer masks wake reasons the
  engine itself writes as `reason=other`: the whitelist now covers every
  reason written by the wake engine and its enqueue sites, including
  `execution_reconciliation_required` and
  `resurrection_execution_reconciliation_required`, which previously showed as
  `reason=other failureClass=failed` on issues with an execution hold.
- A static guard test re-derives the written reasons from the enqueue sites
  and fails when a new reason reaches `agent_wakeup_requests` without being
  added to the whitelist.

## changelog-ru

### Диагностика пробуждений показывает реальные причины движка вместо `other` (OPE-2769)

- `GET /api/issues/{id}/diagnostics/wakes` больше не маскирует причины,
  которые пишет сам wake-движок, как `reason=other`: белый список теперь
  покрывает все значения, записываемые движком и его точками постановки, —
  включая `execution_reconciliation_required` и
  `resurrection_execution_reconciliation_required`, которые раньше на тикете с
  execution-холдом отображались как `reason=other failureClass=failed`.
- Статический тест-сторож заново собирает записываемые причины по точкам
  постановки и падает, если новая причина попадает в `agent_wakeup_requests`
  без добавления в белый список.
