# ADR-0017: На бой только образ, собранный CI

- Status: accepted
- Date: 2026-09-29
- Deciders: Alex
- Scope: product decision from OPE-401

## Source

- Registry: OPE-401 (`decisions/2026-09-29-ci-image-only`)

## Decision

да, вводи правило: только образ из CI

## Consequences

Доска (Myrmidon) на бою запускается только из образа `ghcr.io/itkadr-git/myrmidon@sha256:…`, который собрал GitHub Actions из main или тега `myr-v*`. Локальные сборки и `docker build` на хосте для боя запрещены — и ботам, и оператору. Срочное исправление — только через PR, слияние, сборка CI, выкат через режим обслуживания.
