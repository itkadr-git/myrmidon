# ADR-0041: Оркестратор — единственный владелец жизненного цикла

- Status: accepted
- Date: 2026-09-29
- Deciders: Alex
- Scope: product decision from OPE-401

## Source

- Registry: OPE-401 (`decisions/2026-09-29-orchestrator-lifecycle`)

## Decision

тревога становится задачей, а не kill

## Consequences

Zabbix диагност; гибернация вместо scale-to-zero; хостовые скрипты не трогают флот в обход доски; хостовых скриптов, меняющих статусы агентов/задач, — 0 к 1.7. Принцип П13.
