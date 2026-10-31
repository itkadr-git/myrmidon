# ADR-0033: CORPUS-2.0 (замена RAGFlow): первые три шага — в 1.6.5

- Status: accepted
- Date: 2026-10-06
- Deciders: Alex
- Scope: product decision from OPE-401

## Source

- Registry: OPE-401 (`decisions/2026-10-06-corpus-2-steps`)

## Decision

замеры текущего RAGFlow, пилот разбора документов, пилот индекса; нужно делать в ближайшее время и уже на 1.6.5 возможно на rc4… это может оптимизировать нагрузку на сервер

## Consequences

Эпик OPE-4998; шаги 1–3 — OPE-5002/5003/5004 (1.6.5 rc.4). Код модуля, теневой режим, переключение и снятие RAGFlow — выпуск не назначен, ждёт владельца.
