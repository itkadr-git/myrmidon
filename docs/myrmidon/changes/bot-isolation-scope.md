---
settings-section: BOT-DISK E — host disk usage signal
---

## changelog-en
### Selectable disk isolation scope for bots (BOT-DISK-F)

- Each bot keeps its own disk by default. The owner can now set a scope
  instance (named group, caste, reporting subtree, project, catalog team, or
  the whole company) to shared root: members share one host directory and one
  pnpm store, so hard links work across the bots of the instance. The most
  specific level wins.
- Groups are a first-class entity, managed in Instance settings or through
  `/api/myrmidon/companies/:id/bot-scopes`, with no restart.
- A change marks bots `restart required`; apply runs a checked sequence per
  bot (pause, dry-run of the move, build the replacement, stop, rename, swap,
  start-time self-check, resume). Nothing restarts by itself.
- dockergate accepts the shared bind only for enrolled bots; deploy the gate
  and the board together and enrol before applying.
- Trade-off: members share one uid and directory — share only between bots
  that trust each other. DB: four `myrmidon_scope_*` tables (migration 0300).
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
