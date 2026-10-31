# ADR-0048: Пользователи и администраторы — через интерфейс, саморегистрация запрещена

- Status: accepted
- Date: 2026-09-29
- Deciders: Alex
- Scope: product decision from OPE-401

## Source

- Registry: OPE-401 (`decisions/2026-09-29-users-via-ui`)

## Decision

у меня должна быть возможность создавать админов и пользователей через интерфейс, а не как сейчас ссылками-приглашениями с почтой, но при этом саморегистрация должна быть запрещена

## Consequences

Сейчас `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true`, вход только по приглашению. Доработка идёт в план обновлений Myrmidon.
