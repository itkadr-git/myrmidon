# ADR-0031: Эмбеддинги при смене системы корпуса — переиндексация

- Status: accepted
- Date: 2026-10-04
- Deciders: Alex
- Scope: product decision from OPE-401

## Source

- Registry: OPE-401 (`decisions/2026-10-04-embeddings-reindex`)

## Decision

при переходе все равно переиндексация!

## Consequences

Решение 01.10 «bge-m3 не менять» действует только пока корпус живёт в нынешнем RAGFlow без переиндексации. При переходе на другую систему модель эмбеддингов выбирается заново.
