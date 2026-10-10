---
---

## divergence-new

<!-- after: 1.6.4 — AUTONOMY-DELETE: исполнение класса `delete` на DELETE-маршрутах задач -->

### 1.7 — KNOWLEDGE-2.0: `KNOWLEDGE_INDEX.md` в пакете агента (L-3)

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.7-KNOWLEDGE-INDEX | Доставка знаний в пакет агента расширена указателем: аддитивные колонки `knowledge_items.deliver_to_castes` (jsonb, `["*"]` = все касты) и таблица `knowledge_deliveries` (agent_id, nest_id, bundle_hash, rules_revision_ids, index_item_ids, compiled_at); при сборке профиля бота рядом с `REGULATIONS.md` рендерится `KNOWLEDGE_INDEX.md` — 10–30 строк «slug — заголовок — одна фраза» опубликованных страниц с `deliver_to_castes ∋ каста агента`, тела страниц в промпт не идут; факт доставки пишется в `knowledge_deliveries` (без изменений — без записи); на карточке агента (секция Container) — блок «Знания в пакете»: файл, N правил, указатели, каста, момент сборки | `packages/db/src/schema/knowledge.ts` (колонка + таблица), миграция `0315_knowledge_deliveries.sql` (+ meta journal/snapshot), `server/src/myrmidon/knowledge/domain.ts` (поле дерева + валидация), `server/src/myrmidon/knowledge/store.ts` (чтение/запись, deliveries), `server/src/myrmidon/knowledge/delivery-index.ts` (рендер индекса, детерминированный), `server/src/myrmidon/wiki-cortex/delivery.ts` (второй файл пакета), `server/src/myrmidon/bot-containers/profile-ports.ts` (порты `loadKnowledgeIndex`/`recordKnowledgeDelivery`), `server/src/myrmidon/bot-containers/profile-compile.ts` (сборка второго файла + запись факта), `server/src/myrmidon/bot-containers/routes.ts` + `routes-wiring.ts` (+`knowledgeDelivery` в status), `ui/src/components/myrmidon/AgentCardContainerFields.tsx` + `botContainerApi.ts` (блок «Знания в пакете»), этот фрагмент (settings-en/ru + changelog-en/ru собираются в SETTINGS.md/changelog при release cut) | Архитектура знаний 2.0 §3.7: агент должен видеть, какие знания существуют и как их читать, не раздувая промпт телами страниц; факт доставки нужен экрану агента | `knowledge-delivery-index.myrmidon.test.ts` (детерминированный рендер, фильтр по касте, `["*"]`), `wiki-knowledge-delivery.myrmidon.test.ts` (файл в пакете/пустая доставка/детерминизм), `knowledge-store.db.myrmidon.test.ts` (L-3: round-trip `deliver_to_castes`, ledger доставки, `listPublishedRules`) | Никогда, наше поведение. Удаляется вместе с эпиком: миграции идут только вперёд, снять строки с меткой `myrmidon(1.7 KNOWLEDGE-2.0 L-3)` | (этот PR) |

## changelog-en

### Knowledge pointers in the agent's package (KNOWLEDGE_INDEX, L-3)

- Every bot profile now carries a second knowledge file beside REGULATIONS.md:
  `KNOWLEDGE_INDEX.md`, a compact pointer list (slug — title — one-phrase
  summary) of the published knowledge pages marked `deliver_to_castes` for the
  agent's caste, plus a hint to read pages through the knowledge tools
  (`wiki_read_page` / `wiki_search` until the native knowledge tools of K-6).
  Page bodies never enter the prompt — the index is the address book, the
  bodies stay in the knowledge module.
- `knowledge_items` gains `deliver_to_castes` (jsonb array, `["*"]` = every
  caste): an author marks a page worth delivering, the profile compile picks
  it up per caste. Re-exported trees carry the field; imports read it back.
- The delivery is recorded per agent in `knowledge_deliveries` (bundle hash,
  delivered rule revisions and index item ids, compiled at) — a recompile with
  unchanged content rewrites nothing, and the agent card's Container section
  shows the «Знания в пакете» block: the delivered file, the rule count, the
  caste the index was filtered for, the index slugs, and the compile time
  (the `/bot-container/status` response carries a `knowledgeDelivery` field).
- The compile stays deterministic: same approved rules + same index pages —
  same bytes — no restart; a newly approved rule or a newly marked page
  changes the hash and the bot picks the text up on its next run.

## changelog-ru

### Указатели знаний в пакете агента (KNOWLEDGE_INDEX, L-3)

- Профиль бота теперь несёт второй файл знаний рядом с REGULATIONS.md:
  `KNOWLEDGE_INDEX.md` — компактный указатель (slug — заголовок — одна фраза)
  по опубликованным страницам знаний с отметкой `deliver_to_castes` для касты
  агента, с подсказкой читать страницы через инструменты знаний
  (`wiki_read_page` / `wiki_search` до родных инструментов знаний из K-6). Тела
  страниц в промпт не идут — указатель это адресная книга, тела остаются
  в модуле знаний.
- У `knowledge_items` появилось поле `deliver_to_castes` (jsonb-массив,
  `["*"]` = все касты): автор помечает страницу к доставке, сборка профиля
  берёт её по касте. Экспортируемые деревья несут поле; импорт читает его.
- Доставка фиксируется по агенту в `knowledge_deliveries` (хеш пакета,
  доставленные ревизии правил и id страниц указателя, момент сборки) —
  пересборка с тем же содержимым ничего не перезаписывает, а в секции
  Container карточки агента появляется блок «Знания в пакете»: доставленный
  файл, число правил, каста фильтра указателя, указатели и момент сборки
  (поле `knowledgeDelivery` в ответе `/bot-container/status`).
- Сборка остаётся детерминированной: те же правила и те же страницы указателя —
  те же байты — без рестарта; новое одобренное правило или новая помеченная
  страница меняют хеш, и бот забирает текст на следующем прогоне.
