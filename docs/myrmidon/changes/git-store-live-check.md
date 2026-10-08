---
settings-section: BOT-DISK E — host disk usage signal
---

## changelog-en
### The shared git object store shows its facts, and one command accepts it on a live bot (1.6.5 BOT-DISK-G, part B)

- The start-time self-check records the store's state (`storeState` in
  `git-objects-check.json`: path, enabled, mirrorCount, totalBytes, bounded
  `repos[]`), the same facts ride the clone-hygiene report, and the board
  parses both; an older image reads as `null`, never as an error.
- `GET /api/myrmidon/agents/:id/bot-container/git-store` answers the facts to
  an agent key — the one bot-container route that is not board-only. It reads
  the report file only: no exec into the bot.
- Acceptance is one command on the board host:
  `scripts/myrmidon/deploy/git-objects-live-acceptance.sh --bot <container>` —
  it clones twice inside one live bot and checks that the store holds a mirror
  (≥100 MiB default) and the second clone borrows from it (alternates entry,
  ≤20 MiB `.git`); prints PASS/FAIL per criterion.
## changelog-ru

### Общее хранилище объектов git показывает своё состояние, и одна команда принимает его на живом боте (1.6.5 BOT-DISK-G, часть B)

- Принять общее хранилище 1.6.5 было нечем: 06.10 хранилище на бот-хосте было
  пустым, каждый клон копировал всю историю, раздел ботов стоял на 95 %, — а
  состояния хранилища не видел ни лид, ни доска. Единственный канал, который
  его нёс (лента внимания), доступен только борд-юзеру и отвечает агенту 403,
  а сама проверка требовала `ssh` в бота.
- Самопроверка на старте теперь записывает фактическое состояние хранилища
  рядом со своими четырьмя проверками: `storeState` в `git-objects-check.json` —
  `path`, `enabled`, `mirrorCount`, `totalBytes` и `repos[]` (owner/repo, только
  каталоги, проходящие тест зеркала в обёртке, с потолком
  `MYRMIDON_GIT_STORE_STATE_MAX`, по умолчанию 200). Отсутствующее хранилище
  видно как `enabled: true, mirrorCount: 0`, а не как провал самой проверки.
- Те же факты едут в отчёте гигиены: репортёр внутри контейнера добавляет
  `gitStore` (те же имена полей) в отчёт clone-hygiene, и доска парсит оба —
  в `clone-hygiene.ts` появились `parseGitStoreState`, `gitStore` отчёта и
  `storeState` самопроверки. Старый образ не несёт их вовсе; это читается как
  `null`, а не как ошибка.
- `GET /api/myrmidon/agents/:id/bot-container/git-store` отдаёт факты
  хранилища читателю с агентским ключом — сами факты, снимок со старта и в
  `note` причину, почему поле отсутствует (флаг выключен, нет bot-ключа, отчёта
  ещё нет, отчёт старого образа, отчёт не читается). Он читает только файл
  отчёта: exec в бота не нужен. Это единственный маршрут bot-container не
  только для борд-юзера, за той же границей агентского ключа и компании, что и
  у маршрута статуса; у ленты внимания доски свои правила.
- Приёмка — одна команда на бот-хосте:
  `scripts/myrmidon/deploy/git-objects-live-acceptance.sh --bot <контейнер>`
  (`--list` показывает кандидатов). Она дважды клонирует репозиторий внутри
  одного живого бота и проверяет критерии из тикета самого исправления: хранилище
  не пустое (зеркало есть, размер не меньше `--min-store-mb`, по умолчанию
  100 МиБ; хранилище myrmidon измерено ~145 МБ) и второй клон одалживает из
  него (`alternates` указывает в хранилище, `.git` не больше `--max-clone-git-mb`,
  по умолчанию 20 МиБ, и меньше четверти первого клона). Печатает `PASS`/`FAIL`
  по критерию, выходит с 0/1/2 и убирает свой временный каталог (`--keep`
  оставляет его). Это ручной запасной путь на время, пока образ с двумя фактами
  выше не на хосте.

## settings-en

| `MYRMIDON_GIT_STORE_STATE_MAX` | 1.6.5 BOT-DISK-G | `200` | Ceiling on the number of mirrors the start-time self-check lists in `storeState.repos[]` of `git-objects-check.json` (facts for the board and the lead). A full store is not an error: `mirrorCount` still reports the total, the list stops at the ceiling. `0` is not a disable switch — set `MYRMIDON_GIT_OBJECTS_CHECK=0` to skip the self-check itself | — |

## settings-ru

| `MYRMIDON_GIT_STORE_STATE_MAX` | 1.6.5 BOT-DISK-G | `200` | Потолок числа зеркал, которые самопроверка на старте перечисляет в `storeState.repos[]` файла `git-objects-check.json` (факты для доски и лида). Полное хранилище — не ошибка: `mirrorCount` всё равно отдаёт общее число, а список обрывается на потолке. `0` не выключатель — чтобы пропустить саму самопроверку, задайте `MYRMIDON_GIT_OBJECTS_CHECK=0` | — |