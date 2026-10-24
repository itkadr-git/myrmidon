# ADR-0038: Международный продукт: EN по умолчанию

- Status: accepted
- Date: 2026-09-27
- Deciders: Alex
- Scope: product decision from OPE-401

## Source

- Registry: OPE-401 (`decisions/2026-09-27-international`)

## Decision

EN по умолчанию, локаль у каждого пользователя, свои файлы локализации; документация EN основной, RU отдельными файлами

## Consequences

Ключи схем и идентификаторы латиницей; тест «нет английских строк в RU»; каждый PR — описание EN + RU-файл. Принцип П10.
