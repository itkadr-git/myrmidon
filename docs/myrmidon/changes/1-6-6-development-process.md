---
divergence-section: Трек 5 — эксплуатация
---

## changelog-en

### Project-scoped development process (OPE-9681)

- Documents the `developmentProcess` project setting: `enabled`, `executionPolicy`, and optional `pipelineId`.
- When enabled, only newly created issues in that project inherit the normalized execution policy when they have no explicit policy; other projects retain their existing defaults and explicit issue policies take precedence.
- Adds the English and Russian operator references in `docs/myrmidon/SETTINGS.md` and `docs/myrmidon/SETTINGS.ru.md`.

## changelog-ru

### Процесс разработки, ограниченный проектом (OPE-9681)

- Документирует настройку проекта `developmentProcess`: `enabled`, `executionPolicy` и необязательный `pipelineId`.
- При включении только новые задачи этого проекта наследуют нормализованную политику выполнения, если у них нет явной политики; остальные проекты сохраняют прежние значения по умолчанию, а явная политика задачи имеет приоритет.
- Добавлены справочные разделы для операторов на английском и русском языках в `docs/myrmidon/SETTINGS.md` и `docs/myrmidon/SETTINGS.ru.md`.

## divergence

| 1.6.6-DEVFLOW-PROJECT | Project setting `developmentProcess` is documented as a project-scoped opt-in. The implementation applies its normalized execution policy only to new issues for enabled projects without an explicit policy; `null`/disabled projects and other projects keep existing behavior. | `packages/shared/src/validators/project.ts`, `server/src/services/projects.ts`, `server/src/services/issues.ts`, `server/src/__tests__/issues-service.test.ts`, and the settings references above | Operators need to know the exact enablement, inheritance precedence, and isolation boundary before using the development workflow | Existing project behavior and issue policies remain unchanged when the setting is null/disabled or an issue supplies an explicit policy | PR #1956 |
