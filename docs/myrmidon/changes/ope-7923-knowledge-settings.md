## changelog-en

### Settings → Knowledge screen (company knowledge module settings) (OPE-7923, 1.7 KNOWLEDGE-2.0 L-11)

- Company Settings → Knowledge screen edits the limits, the auto-accept threshold,
  the sweep schedule and the section reviewers of the knowledge module — one set
  per company, stored in the `knowledge_settings` table.
- Wire surface: `GET`/`PATCH /api/myrmidon/companies/:companyId/knowledge/settings`;
  reads require company access, writes additionally require an instance admin and
  are journaled as `knowledge.settings_updated`.
- Every field resolves UI → env → default, the same precedence rule the corpus
  module uses: a value saved from the screen wins, otherwise the matching
  environment variable, otherwise the default. The screen badges the winning layer
  per field. A stored value that is unreadable falls through to env, then default —
  a broken row never becomes a runtime value. Section reviewers are a board choice
  only (`ui` when any are saved, else `default`) and have no env variable.

## changelog-ru

### Экран «Настройки → Знания» (настройки модуля знаний компании) (OPE-7923, 1.7 KNOWLEDGE-2.0 L-11)

- Экран Настройки компании → Знания редактирует лимиты, порог автопринятия,
  расписание сбора и рецензентов разделов модуля знаний — один набор на компанию,
  хранится в таблице `knowledge_settings`.
- Провод: `GET`/`PATCH /api/myrmidon/companies/:companyId/knowledge/settings`;
  чтение — по доступу к компании, запись дополнительно требует instance admin и
  журналируется как `knowledge.settings_updated`.
- Каждое поле разрешается UI → env → default (тот же приоритет, что у модуля
  корпуса): сохранённое с экрана выигрывает, иначе переменная окружения, иначе
  умолчание. Экран бейджит выигравший слой по каждому полю. Нечитаемое сохранённое
  значение падает в env, затем в default — сломанная строка не становится
  рантайм-значением. Рецензенты разделов — только выбор доски (`ui`, когда сохранён
  хоть один, иначе `default`), своей переменной окружения не имеют.

## settings-en-new

### 1.7 — KNOWLEDGE-2.0 L-11: Settings → Knowledge (company knowledge module settings)

Settings of `server/src/myrmidon/knowledge/settings.ts` (the 1.7 KNOWLEDGE-2.0 L-11
track). The Company Settings → Knowledge screen edits the limits, the auto-accept
threshold, the sweep schedule and the section reviewers of the knowledge module, one
set per company, stored in the `knowledge_settings` table. The wire surface is
`GET`/`PATCH /api/myrmidon/companies/:companyId/knowledge/settings`; reads require
company access, writes additionally require an instance admin and are journaled as
`knowledge.settings_updated`.

Every field resolves UI → env → default, the same precedence rule the corpus module
uses. A value saved from the screen wins; otherwise the matching environment
variable below; otherwise the default. The screen badges the winning layer per
field. A stored value that is unreadable falls through to env, then default — a
broken row never becomes a runtime value. Section reviewers are a board choice only
(`ui` when any are saved, else `default`) and have no env variable.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_KNOWLEDGE_MAX_ITEMS` | 1.7-KNOWLEDGE-L11 | `5000` | Maximum number of knowledge items one company keeps | 1 to 100000; out of bounds falls back to the default |
| `MYRMIDON_KNOWLEDGE_MAX_REVISION_BYTES` | 1.7-KNOWLEDGE-L11 | `262144` (256 KiB) | Maximum size of one knowledge revision, in bytes | 1024 to 5242880; out of bounds falls back to the default |
| `MYRMIDON_KNOWLEDGE_AUTO_ACCEPT` | 1.7-KNOWLEDGE-L11 | `false` | Auto-accept of incoming knowledge suggestions at or above the confidence threshold | `false` — every suggestion goes through review |
| `MYRMIDON_KNOWLEDGE_AUTO_ACCEPT_MIN_CONFIDENCE` | 1.7-KNOWLEDGE-L11 | `0.9` | Confidence floor for auto-accept, a fraction in [0, 1] stored and edited as a string | Out of [0, 1] falls back to the default |
| `MYRMIDON_KNOWLEDGE_SCHEDULE` | 1.7-KNOWLEDGE-L11 | `0 0 0 0 0` | Five-field cron of the knowledge sweep | The default never fires — the sweep stays off until a schedule is chosen; at most 64 characters |

## settings-ru-new

### 1.7 — KNOWLEDGE-2.0 L-11: Настройки → Знания (настройки модуля знаний компании)

Настройки `server/src/myrmidon/knowledge/settings.ts` (трек 1.7 KNOWLEDGE-2.0 L-11).
Экран Настройки компании → Знания редактирует лимиты, порог автопринятия, расписание
сбора и рецензентов разделов модуля знаний — один набор на компанию, хранится в
таблице `knowledge_settings`. Провод —
`GET`/`PATCH /api/myrmidon/companies/:companyId/knowledge/settings`; чтение — по
доступу к компании, запись дополнительно требует instance admin и журналируется как
`knowledge.settings_updated`.

Каждое поле разрешается UI → env → default (тот же приоритет, что у модуля корпуса):
сохранённое с экрана выигрывает, иначе переменная окружения, иначе умолчание. Экран
бейджит выигравший слой по каждому полю. Нечитаемое сохранённое значение падает в
env, затем в default — сломанная строка не становится рантайм-значением. Рецензенты
разделов — только выбор доски (`ui`, когда сохранён хоть один, иначе `default`),
своей переменной окружения не имеют. Полная таблица переменных и границ: раздел
«1.7 — KNOWLEDGE-2.0 L-11» в SETTINGS.md.
