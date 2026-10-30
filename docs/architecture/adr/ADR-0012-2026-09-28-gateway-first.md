# ADR-0012: Агенты через шлюз hermes — первый приоритет

- Status: accepted
- Date: 2026-09-28
- Deciders: Alex
- Scope: product decision from OPE-401

## Source

- Registry: OPE-401 (`decisions/2026-09-28-gateway-first`)

## Decision

в первом приоритете перенос всех наработок в hermes_gateway, он должен поддерживать всё, что сейчас есть в hermes_local, тогда песочница и изоляция просто будут не обязательны

## Consequences

Основной путь агентов — hermes_gateway, свой контейнер на проект или бота; hermes_local — только на время перехода.
