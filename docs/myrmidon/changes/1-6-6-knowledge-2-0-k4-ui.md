---
divergence-section: UI-2.0 — оболочка нового интерфейса (UI-0a)
---

## changelog-en

### Knowledge and Regulations screens in UI 2.0 (OPE-5957, K-4)

- Added the read-only "Knowledge" screen (space tree, search, `[[...]]` links, sources panel, revision diff and rollback by approver kind) and the "Regulations" screen of Autonomy to the UI 2.0 shell.
- The "Work" navigation group is shown only after the server confirms the knowledge REST (K-2) responds, so nothing appears while the API is not deployed.

## changelog-ru

### Экраны «Знания» и «Регламенты» в UI 2.0 (OPE-5957, K-4)

- В оболочку UI 2.0 добавлены экран «Знания» (дерево пространств, поиск, ссылки `[[...]]`, панель источников, diff ревизий и откат по `approver_kind`) и экран «Регламенты» в Автономии.
- Группа «Работа» в навигации появляется только после того, как сервер подтвердил ответ REST знаний (K-2); пока API не выкачен, пунктов нет.

## divergence

| OPE-5957 | Экраны «Знания» и «Регламенты» UI 2.0 за флагом `enableMyrmidonUi2` и проверкой доступности REST знаний | Вендорской вики/знаний нет; UI 2.0 shell navigation | Человек читает и одобряет знания без плагина (архитектура знаний 2.0, K-4); поведение живёт в форке | `knowledgeModel.myrmidon.test.ts`, `regulationsModel.myrmidon.test.ts`, `no-english-in-ru.knowledge.myrmidon.test.ts`, CI affected tests | Когда вендор добавит эквивалентный модуль знаний, сверить API и снять fork routes, navigation, locale, screens, tests и docs | #1412 |
