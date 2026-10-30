# ADR-0024: Лимиты — сигнал, не блок; кап не ставить

- Status: accepted
- Date: 2026-09-30
- Deciders: Alex
- Scope: product decision from OPE-401

## Source

- Registry: OPE-401 (`decisions/2026-09-30-no-budget-cap`)

## Decision

кап не ставить

## Consequences

Жёсткий отказ — только явно согласованный уровень; глобальный «только сигнал» действует до BUDGET-CONFIG. Боевой конвейер никогда не останавливается молча; инцидент бюджета = карточка владельцу «расширить на $N / остановить».
