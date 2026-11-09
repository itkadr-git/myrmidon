# ADR-0013: Доска сама поднимает контейнеры (вариант Б)

- Status: accepted
- Date: 2026-09-28
- Deciders: Alex
- Scope: product decision from OPE-401

## Source

- Registry: OPE-401 (`decisions/2026-09-28-board-manages-containers`)

## Decision

это первый приоритет

## Consequences

Причина — OOM доски 28.09 08:10 UTC: около 35 процессов hermes внутри контейнера доски (8 ГБ), все прогоны умерли. Доска сама управляет контейнерами ботов.
