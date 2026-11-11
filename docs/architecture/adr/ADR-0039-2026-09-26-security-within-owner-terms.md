# ADR-0039: Безопасность — внутри условий владельца

- Status: accepted
- Date: 2026-09-26
- Deciders: Alex
- Scope: product decision from OPE-401

## Source

- Registry: OPE-401 (`decisions/2026-09-26-security-within-owner-terms`)

## Decision

каждой свой ключ

## Consequences

Права по потребности (ключ на роль, свой секрет на каждую), секреты только в хранилище и никогда в задачах/PR, прокси исходящего трафика до общения ботов с внешними людьми; root ADM и hermes_local под управлением доски неприкосновенны, пока нужны. Принцип П11.
