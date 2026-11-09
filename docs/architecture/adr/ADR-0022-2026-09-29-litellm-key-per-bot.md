# ADR-0022: Ключ LiteLLM на каждого бота

- Status: accepted
- Date: 2026-09-29
- Deciders: Alex
- Scope: product decision from OPE-401

## Source

- Registry: OPE-401 (`decisions/2026-09-29-litellm-key-per-bot`)

## Decision

ты сам можешь создать отдельный ключ на каждого бота

## Consequences

Бот в контейнере получает свой виртуальный ключ LiteLLM `bot-<имя>`: без лимита трат, набор моделей как у прежнего ключа. Первый ключ — `bot-life` (29.09); до этого life ходила под ключом `bbq`, расход смешивался.
