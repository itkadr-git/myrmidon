# ADR-0037: Все настройки — в интерфейсе, без перезапуска

- Status: accepted
- Date: 2026-09-27
- Deciders: Alex
- Scope: product decision from OPE-401

## Source

- Registry: OPE-401 (`decisions/2026-09-27-ui-no-restart`)

## Decision

Это должно задаваться в интерфейсе!

## Consequences

Env — только принудительное переопределение (инфра-адреса, сокеты). Функция не принимается без экрана настроек; к 2.0 число переключателей «только env» → 0. Принципы П1, П2.
