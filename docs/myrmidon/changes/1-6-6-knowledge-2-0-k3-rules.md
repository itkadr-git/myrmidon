---
divergence-section: KNOWLEDGE-2.0 — единый модуль знаний
---

## changelog-en

### Rules in the knowledge module: derivation, resolver, delivery (KNOWLEDGE-2.0 K-3)

- The caste directory gains `sensitive` (additive migration
  `0315_knowledge_rules.sql`): a sensitive caste's rules are the owner's to
  approve, every other caste's are the board operator's — the owner's matrix of
  29.09 ("разработка — оператор доски (ADM), площадки и SMM — Alex").
  `cmo` seeds as sensitive; the flag is edited through the castes API.
- `approver_kind` is derived from the rule's castes in code
  (`server/src/myrmidon/knowledge/rules.ts`): a rule that governs any sensitive
  caste asks for `owner`, every other rule asks for `operator`. Nobody types the
  field by hand, and approving as a lower grade still answers 403 — the SMM rule
  is refused to the board operator and approved by the owner.
- A rule's castes live on the knowledge item (`knowledge_items.roles`, a GIN
  index) — the port of the wiki model's `roles`, `["*"]` meaning every caste —
  and ride through the tree export/import (`roles:` line).
- The delivery path reads the knowledge module:
  `knowledge.rules.resolved(nest, caste)` feeds the profile compiler, so the
  wiki tables are no longer a second carrier of rules. `REGULATIONS.md` gains a
  `Source: <slug> · revision <n>` line in every section (the page id is the
  slug) plus a `Provenance:` line when the revision carries sources, and stays a
  pure function of the approved set — same approved revisions, same bytes.
- N-4: `0315_knowledge_rules.sql` moves the legacy wiki regulations into
  `knowledge_items` as `kind=rule` — text, history, statuses, the delivered
  revision and one provenance record per revision. The slug stays the page key,
  so every reference resolves to the same page.

## changelog-ru

### Правила в модуле знаний: вывод, резолвер, доставка (KNOWLEDGE-2.0 K-3)

- Справочник каст получает `sensitive` (аддитивная миграция
  `0315_knowledge_rules.sql`): правила чувствительной касты утверждает владелец,
  правила остальных каст — оператор доски (матрица владельца от 29.09:
  «разработка — оператор доски (ADM), площадки и SMM — Alex»). Сид помечает
  `cmo` чувствительной; флаг правится через API каст.
- `approver_kind` выводится из каст правила в коде
  (`server/src/myrmidon/knowledge/rules.ts`): правило, затрагивающее
  чувствительную касту, требует `owner`, любое другое — `operator`. Поле никто
  не вводит руками, а утверждение более низким рангом по-прежнему даёт 403:
  правило SMM отклоняется оператору доски и утверждается владельцем.
- Касты правила живут на элементе знаний (`knowledge_items.roles`, GIN-индекс) —
  перенос `roles` вики-модели, `["*"]` = все касты — и проходят через
  экспорт/импорт дерева (строка `roles:`).
- Путь доставки читает модуль знаний: `knowledge.rules.resolved(nest, caste)`
  питает компилятор профиля, вики-таблицы перестают быть вторым носителем
  правил. В `REGULATIONS.md` в каждой секции появляется строка
  `Source: <slug> · revision <n>` (id страницы = slug) и строка `Provenance:`
  при наличии источников; файл остаётся чистой функцией набора утверждённых
  ревизий — тот же набор, те же байты.
- N-4: `0315_knowledge_rules.sql` переносит легаси-регламенты вики в
  `knowledge_items` как `kind=rule` — текст, история, статусы, доставленная
  ревизия и одна запись провенанса на ревизию. Slug остаётся ключом страницы,
  поэтому все ссылки разрешаются в ту же страницу.

## divergence-new

### 1.6.6 — KNOWLEDGE-2.0 K-3: правила как `kind=rule`, одобрение по касте, доставка

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.6-KNOWLEDGE-K3 | Один носитель правил: регламенты переезжают в `knowledge_items` (`kind=rule`, колонка `roles` с GIN-индексом и строка `roles:` в формате дерева), `approver_kind` выводится в коде из справочника каст (новое поле `agent_castes.sensitive`; сид помечает `cmo`), гейт утверждения — по рангам человеческих ролей (operator < admin < owner; агент не проходит никогда), доставка читает `knowledge.rules.resolved(nest, caste)` вместо вики-таблиц, в `REGULATIONS.md` у каждой секции строка `Source: <slug> · revision <n>` и строка `Provenance:` при источниках, файл остаётся чистой функцией набора утверждённых ревизий; миграция `0315` аддитивна и идемпотентна (K-1 — домен и хранилище `knowledge_*`, миграция `0313` — слита в `main`). Чтение регламентов из JSON документа автономии (`GET /myrmidon/autonomy.regulations`, `wikiPageId` = slug) — следующая часть той же задачи. | Наши файлы: `server/src/myrmidon/knowledge/rules.ts`, `knowledge-rules.myrmidon.test.ts`, `knowledge/{domain,store}.ts` (колонка `roles`), `wiki-cortex/{render,delivery,types,service}.ts`, `bot-containers/profile-ports.ts` (доставка через модуль знаний), `packages/db/src/schema/{knowledge,agent_castes}.ts`, `packages/db/src/migrations/0315_knowledge_rules.sql` (+ meta journal/snapshot), `packages/shared/src/myrmidon-castes.ts`; в вендоре помечены: `packages/db/src/schema/index.ts` (экспорт таблиц) | Владелец решил 29.09, что регламенты утверждаются по кастам (`разработка — оператор доски, площадки и SMM — Alex`), а знание 2.0 требует одного носителя правил: до K-3 правила жили в двух местах (вики-таблицы и JSON документа автономии) и утверждались по свободному тексту роли | `knowledge-rules.myrmidon.test.ts`: `approver_kind` из касты (sensitive → `owner`, иначе `operator`, `*` → `operator`), правило SMM оператору → 403 и владельцу → ok, резолвер отдаёт доставленные ревизии только своих каст и `*`, пропускает черновики и элементы без доставленной ревизии, `Source:` в каждой секции, `pageId = slug`, повторный рендер байт в байт | Никогда, наше поведение. Колонки аддитивны, легаси-таблицы вики остаются до конца переноса (K-6) | (этот PR) |