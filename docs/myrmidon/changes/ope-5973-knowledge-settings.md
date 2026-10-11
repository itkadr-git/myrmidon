---
divergence-section: 1.7 — KNOWLEDGE-2.0: экран «Настройки → Знания» (L-11)
settings-section: 1.7 — KNOWLEDGE-2.0: knowledge settings (L-11)
---

## changelog-en

### Knowledge has a settings screen (1.7 KNOWLEDGE-2.0 L-11)

- Company Settings has a new **Knowledge** section
  (`/company/settings/knowledge`): the item limit, the revision size limit,
  auto-accept with its minimum confidence, the sweep schedule and the section
  reviewers.
- Every field carries a badge of the layer that produced its effective value:
  `UI` when it was saved from the screen, `env` when it comes from the matching
  environment variable, `default` otherwise. A saved value always wins over the
  environment, and the environment always wins over the default.
- A value that is out of bounds is refused before it is written, naming the
  field. The schedule is five cron fields; the default `0 0 0 0 0` never
  fires, so the sweep stays off until a schedule is chosen.
- Section reviewers are a list of section, reviewer kind (`user` or `agent`)
  and reviewer id. A section without a reviewer is not routed.

## changelog-ru

### У знаний появился экран настроек (1.7 KNOWLEDGE-2.0 L-11)

- В настройках компании появился раздел **Знания**
  (`/company/settings/knowledge`): предел числа записей, предел размера
  ревизии, авто-принятие с минимальной уверенностью, расписание обхода и
  ревьюеры разделов.
- У каждого поля бейдж слоя, из которого взято действующее значение: `UI`,
  если его сохранили с экрана, `env`, если оно пришло из переменной
  окружения, и «по умолчанию» в остальных случаях. Сохранённое значение
  всегда старше окружения, окружение всегда старше значения по умолчанию.
- Значение вне границ отклоняется до записи, с именем поля. Расписание —
  пять полей cron; значение по умолчанию `0 0 0 0 0` не срабатывает, поэтому
  обход выключен, пока расписание не выбрано.
- Ревьюеры разделов — список из раздела, типа ревьюера (`user` или `agent`)
  и идентификатора. Раздел без ревьюера никуда не маршрутизируется.

## divergence-new

### 1.7 — KNOWLEDGE-2.0: экран «Настройки → Знания» (L-11)

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.7-KNOWLEDGE-L11 | Экран «Знания» в настройках компании (`/company/settings/knowledge`, пункт в `CompanySettingsNav` после «Корпус»): пределы, авто-принятие, расписание, ревьюеры разделов. Каждое поле несёт бейдж источника `ui`/`env`/`default`. Значения хранятся в `knowledge_settings` (строка на компанию, пустая колонка — «не задано с экрана»). | Наши файлы: `packages/shared/src/myrmidon-knowledge-settings.ts` (+тест), `packages/db/src/schema/knowledge.ts`, `packages/db/src/migrations/0315_knowledge_settings.sql`, `server/src/myrmidon/knowledge/{settings.ts,routes.ts}`, `ui/src/components/myrmidon/knowledge/{knowledgeSettingsApi.ts,KnowledgeSettingsScreen.tsx}`; в вендоре помечены `myrmidon(1.7 KNOWLEDGE-2.0 L-11)`: `packages/shared/src/index.ts`, `packages/db/src/schema/index.ts`, `server/src/app.ts`, `ui/src/App.tsx`, `ui/src/components/access/CompanySettingsNav.tsx` (+тест), `ui/src/i18n/myrmidon-locales/{en,ru}.json` | Архитектура знаний 2.0, раздел 6, L-11: модуль настраивается из интерфейса, а не только переменными окружения | `myrmidon-knowledge-settings.test.ts` (приоритет ui→env→default, границы, cron, ревьюеры), `CompanySettingsNav.test.tsx` (вкладка) | Когда модуль знаний перестанет читать эти пределы | OPE-5973 |

## settings-en-new

### 1.7 — KNOWLEDGE-2.0: knowledge settings (L-11)

Company Settings → Knowledge (`/company/settings/knowledge`) reads and writes
`GET`/`PATCH /api/myrmidon/companies/:companyId/knowledge/settings`. A field
resolves UI → env → default; the response badges the winning layer. An empty
column means the screen never set it.

| Field | Env | Default | Bounds |
|---|---|---|---|
| `maxItems` | `MYRMIDON_KNOWLEDGE_MAX_ITEMS` | 5000 | 1 to 100000 |
| `maxRevisionBytes` | `MYRMIDON_KNOWLEDGE_MAX_REVISION_BYTES` | 262144 | 1024 to 5242880 |
| `autoAcceptEnabled` | `MYRMIDON_KNOWLEDGE_AUTO_ACCEPT` | false | boolean |
| `autoAcceptMinConfidence` | `MYRMIDON_KNOWLEDGE_AUTO_ACCEPT_MIN_CONFIDENCE` | 0.9 | 0 to 1, two decimals |
| `schedule` | `MYRMIDON_KNOWLEDGE_SCHEDULE` | `0 0 0 0 0` (never fires) | five cron fields |
| `sectionReviewers` | — | empty list | section, kind `user`/`agent`, id |

## settings-ru-new

### 1.7 — KNOWLEDGE-2.0: настройки знаний (L-11)

Настройки компании → Знания (`/company/settings/knowledge`) читают и пишут
`GET`/`PATCH /api/myrmidon/companies/:companyId/knowledge/settings`. Поле
разрешается как UI → env → значение по умолчанию; ответ помечает победивший
слой. Пустая колонка значит, что с экрана значение не задавали.

| Поле | Переменная | По умолчанию | Границы |
|---|---|---|---|
| `maxItems` | `MYRMIDON_KNOWLEDGE_MAX_ITEMS` | 5000 | от 1 до 100000 |
| `maxRevisionBytes` | `MYRMIDON_KNOWLEDGE_MAX_REVISION_BYTES` | 262144 | от 1024 до 5242880 |
| `autoAcceptEnabled` | `MYRMIDON_KNOWLEDGE_AUTO_ACCEPT` | false | логическое |
| `autoAcceptMinConfidence` | `MYRMIDON_KNOWLEDGE_AUTO_ACCEPT_MIN_CONFIDENCE` | 0.9 | от 0 до 1, два знака |
| `schedule` | `MYRMIDON_KNOWLEDGE_SCHEDULE` | `0 0 0 0 0` (не срабатывает) | пять полей cron |
| `sectionReviewers` | — | пустой список | раздел, тип `user`/`agent`, идентификатор |
