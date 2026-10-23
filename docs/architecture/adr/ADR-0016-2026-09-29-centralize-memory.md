# ADR-0016: Централизовать память ботов

- Status: accepted
- Date: 2026-09-29
- Deciders: Alex
- Scope: product decision from OPE-401

## Source

- Registry: OPE-401 (`decisions/2026-09-29-centralize-memory`)

## Decision

память нужно централизовать

## Consequences

Цель — память не привязана к месту запуска бота: долговременная память — в Hindsight; история разговоров — в центральном хранилище, а не в локальном state.db; навыки — с доски; настройки — из карточки агента.
