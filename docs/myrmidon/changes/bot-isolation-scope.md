---
settings-section: BOT-DISK E — host disk usage signal
---

## changelog-en

### Selectable disk isolation scope for bots (BOT-DISK-F)

- Each bot keeps its own disk by default, exactly as before. The owner can now set a **scope
  instance** (an explicit named group, a caste, a reporting subtree, a project, an installed
  catalog team, or the whole company) to **shared root**: its members use one host directory
  with **one pnpm store** and a subdirectory per bot, so hard links work within a bot and across
  the bots of the instance, and a package is stored once for all of them. Different instances never
  share a directory. The most specific level wins: the agent's own override, group, caste,
  subtree, project, catalog team, company; an instance set to *isolated* stops the search.
- **Groups** are a first-class entity: create, rename, delete and change members in Instance
  settings, "Disk isolation of bots" (and through `/api/myrmidon/companies/:id/bot-scopes`), with no
  restart. An agent may be in several groups but only one may define its scope; an agent in several
  groups (or projects) that each define one is flagged and the owner must choose which decides.
  The resolver is one shared module other policies (the container scope, later) can reuse.
- A change marks the affected bots **restart required**; nothing restarts by itself. *Apply* runs,
  per bot, in order: pause (maintenance window), check the move (refuses on any conflict before
  anything stops; never deletes or merges), build the replacement while the old one still runs (a
  gate refusal changes nothing), stop, move the three directories by `rename`, swap in the new
  container, start-time hard-link self-check, resume. Not run on any host by this change.
- Container: a member has one bind, `<shared root>/<instance>:/bot-scope`, and a tmpfs over `/data`
  with links into its own `<botKey>/` subdirectory, made by the entrypoint from
  `MYRMIDON_BOT_SCOPE_SUBDIR`; the profile points pnpm at `/bot-scope/.pnpm-store`. Image: new label
  `myrmidon.bot-runtime.scope=1`, `WORKDIR /` (the entrypoint enters `/workspace`), `/bot-scope`
  write-safe. Rebuild the bot image before the first shared bot.
- dockergate accepts the shared bind only for a bot enrolled for that instance
  (`bots[].scopeInstances`, new `scopeRoot`), and only the instance's own directory; the gate
  checks the instance tree like a volume root. Deploy the gate and the board together and enrol
  the bots **before** applying a scope change. See [bot-disk-cache.md](../bot-disk-cache.md) and
  [dockergate.md](../dockergate.md).
- **Trade-off:** members of one instance run as one uid and mount the whole instance directory,
  so each can read and write the others' `hermes/` (keys included), `workspace` and `scratch`.
  Share only between bots that trust each other.
- DB: tables `myrmidon_scope_groups`, `myrmidon_scope_group_members`, `myrmidon_scope_settings`,
  `myrmidon_scope_agent_prefs` (migration 0300).

## changelog-ru

### Выбираемая область изоляции дисков ботов (BOT-DISK-F)

- По умолчанию у каждого бота свой диск, как и раньше. Теперь владелец может перевести **экземпляр
  области** (явную именованную группу, касту, поддерево подчинения, проект, установленную команду
  каталога или всю компанию) в **общий корень**: его участники используют один каталог хоста с
  **одним хранилищем pnpm** и подкаталогом на бота, так что жёсткие ссылки работают внутри бота и между
  ботами экземпляра, а пакет хранится один раз на всех. Разные экземпляры никогда не делят каталог.
  Побеждает самый частный уровень: переопределение агента, группа, каста, поддерево, проект, команда
  каталога, компания; экземпляр в режиме *изолирован* прекращает поиск.
- **Группы** — самостоятельная сущность: создание, переименование, удаление и состав меняются в
  настройках экземпляра, «Изоляция дисков ботов» (и через `/api/myrmidon/companies/:id/bot-scopes`),
  без перезапуска. Агент может быть в нескольких группах, но область задаёт только одна; агент в
  нескольких группах (или проектах), каждая из которых её задаёт, помечается, и владелец выбирает,
  какая решает. Резолвер — один общий модуль, который смогут переиспользовать другие политики (позже —
  область контейнеров).
- Изменение помечает затронутых ботов **нужен перезапуск**; сами ничего не перезапускается. *Применить*
  для бота делает по порядку: пауза (окно обслуживания), проверка переноса (отказ при любом конфликте
  до остановки; ничего не удаляется и не сливается), сборка замены, пока старый контейнер работает
  (отказ шлюза ничего не меняет), остановка, перенос трёх каталогов через `rename`, подмена новым
  контейнером, самопроверка жёстких ссылок при старте, возобновление. Этим
  изменением ни на одном хосте не запускалось.
- Контейнер: у участника одна привязка `<общий корень>/<экземпляр>:/bot-scope` и tmpfs поверх `/data` с
  ссылками в собственный подкаталог `<botKey>/`, которые делает entrypoint по `MYRMIDON_BOT_SCOPE_SUBDIR`;
  профиль направляет pnpm в `/bot-scope/.pnpm-store`. Образ: новая метка `myrmidon.bot-runtime.scope=1`,
  `WORKDIR /` (entrypoint сам входит в `/workspace`), `/bot-scope` разрешён для записи. Пересоберите образ
  бота до первого общего бота.
- dockergate принимает общую привязку только для бота, записанного на этот экземпляр
  (`bots[].scopeInstances`, новый `scopeRoot`), и только собственный каталог экземпляра; шлюз проверяет
  дерево экземпляра как корень томов. Выкатывайте шлюз и доску вместе и записывайте ботов **до** применения
  смены области. См. [bot-disk-cache.ru.md](../bot-disk-cache.ru.md) и [dockergate.ru.md](../dockergate.ru.md).
- **Компромисс:** участники одного экземпляра работают с одним uid и монтируют весь каталог экземпляра,
  поэтому каждый может читать и писать `hermes/` (с ключами), `workspace` и `scratch` остальных. Делитесь
  только между ботами, которые доверяют друг другу.
- БД: таблицы `myrmidon_scope_groups`, `myrmidon_scope_group_members`, `myrmidon_scope_settings`,
  `myrmidon_scope_agent_prefs` (миграция 0300).

## settings-en

| `MYRMIDON_BOT_SCOPE_ROOT` | BOT-DISK-F | `<MYRMIDON_BOT_VOLUME_ROOT>/.scopes` | Host directory of shared isolation-scope instances: one subdirectory `<kind>-<id>` per instance (one pnpm store plus a subdirectory per member bot). Keep it on the same filesystem as the volume root. The same path as `scopeRoot` in the dockergate configuration | Leave unset (the default) and set no scope to *shared root*: every bot stays isolated |

## settings-ru

| `MYRMIDON_BOT_SCOPE_ROOT` | BOT-DISK-F | `<MYRMIDON_BOT_VOLUME_ROOT>/.scopes` | Каталог хоста общих экземпляров области изоляции: по подкаталогу `<kind>-<id>` на экземпляр (одно хранилище pnpm и подкаталог на каждого бота-участника). Держите на той же файловой системе, что и корень томов. Тот же путь, что `scopeRoot` в конфигурации dockergate | Не задавать (по умолчанию) и не переводить ни одну область в *общий корень*: каждый бот остаётся изолированным |
