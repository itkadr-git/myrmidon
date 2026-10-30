# ADR-0044: Замок на слияние: обязательное одобрение сопровождающего

- Status: accepted
- Date: 2026-09-29
- Deciders: Alex
- Scope: product decision from OPE-401

## Source

- Registry: OPE-401 (`decisions/2026-09-29-merge-approval-lock`)

## Decision

Замок на слияние — делать

## Consequences

Обязательная проверка «одобрение сопровождающего»: подписанное оператором одобрение последнего коммита PR. Команда пишет от имени itkadr-git, поэтому GitHub сам их не различает.
