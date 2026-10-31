## changelog-en

### Hermes profile skills are verified by fact, migrated, and never shared (HERMES-SKILLS-DELIVERY-CHECK)

- `reconcileHermesPaperclipSkills` proves the result instead of trusting the install
  calls: it reads the agent's skills directory again and names every desired skill whose
  link is absent, broken, foreign or pointed at the wrong source. A run that cannot
  deliver a desired skill now fails at start with the skill name and the reason instead
  of running without it.
- Reconcile migrates what an earlier rollout left behind in a profile: a link that
  resolves into the shared `~/.hermes/skills` tree is relinked to the managed source of
  the same skill, and a link whose destination is gone is moved to
  `<HERMES_HOME>/skills.pre-myrmidon/<name>.pre-myrmidon-<date>` — kept as evidence,
  never deleted — so the managed skill can take its place. Both steps apply to profiles
  only; without `HERMES_HOME` the agent keeps the vendor behaviour in the shared scope.
- The profile race is pinned by tests: two agents with different `HERMES_HOME` reconcile
  in parallel without overwriting each other's links, and a third agent without
  `HERMES_HOME` neither breaks nor gets broken by the profiles.


## changelog-ru

### Навыки в профилях Hermes проверяются фактом, мигрируются и не делятся между агентами (HERMES-SKILLS-DELIVERY-CHECK)

- `reconcileHermesPaperclipSkills` доказывает результат, а не доверяет вызовам установки:
  каталог навыков агента читается заново, и каждый желаемый навык, чья ссылка
  отсутствует, битая, чужая или указывает не на тот источник, называется в ошибке запуска
  вместе с причиной — вместо прогона без навыка.
- Reconcile мигрирует то, что оставил в профиле ранний обход: ссылка, разрешающаяся внутрь
  общего дерева `~/.hermes/skills`, перелинковывается на управляемый источник того же
  навыка, а ссылка на исчезнувший источник переносится в
  `<HERMES_HOME>/skills.pre-myrmidon/<имя>.pre-myrmidon-<дата>` — как свидетельство,
  ничего не удаляется — чтобы управляемый навык встал на её место. Оба шага действуют
  только в профилях; без `HERMES_HOME` агент сохраняет вендорское поведение в общем скоупе.
- Гонка профилей закреплена тестами: два агента с разными `HERMES_HOME` reconcili'ят
  параллельно и не перетирают ссылки друг друга, а третий агент без `HERMES_HOME` не ломает
  профили и не ломается от них.


## divergence-replace

<!-- section: Трек 4 — чаты и навыки -->
| H1 | Навыки `hermes_local` ставятся и перечисляются в `<HERMES_HOME>/skills`, если `HERMES_HOME` задан в карточке агента; результат прогона после reconcile сверяется фактом — каждая желаемая ссылка проверяется в каталоге агента (`readdir` + `readlink`) и расхождение останавливает прогон с именем навыка и причиной; настоящий каталог на месте управляемого навыка переносится в `<HERMES_HOME>/skills.pre-myrmidon/`; следы раннего обхода мигрируются: ссылка внутрь общего `~/.hermes/skills` перелинковывается на управляемый источник, ссылка на исчезнувший источник переносится в тот же бэкап | `packages/adapters/hermes/src/server/skills.ts`, `packages/adapters/hermes/src/server/execute.ts` (одна точка вызова: строка журнала) + `packages/adapters/hermes/src/server/myrmidon-skills-home.ts` | Hermes читает навыки профиля из `<HERMES_HOME>/skills`, а адаптер писал в общий `<HOME>/.hermes/skills` и стирал там ссылки соседних агентов; отчёт об установке не доказывал доставку, а в профилях оставались ссылки ручного обхода. У вендора не исправлено (родственный открытый PR #6230) | `packages/adapters/hermes/src/server/skills.myrmidon.test.ts` | Когда вендор начнёт ставить навыки в `HERMES_HOME`: удалить куски с меткой `myrmidon(H1)`, модуль и тест; миграция — `docs/myrmidon/migrations/h1-hermes-skills.md` | [#40](https://github.com/itkadr-git/myrmidon/pull/40) + этот PR |