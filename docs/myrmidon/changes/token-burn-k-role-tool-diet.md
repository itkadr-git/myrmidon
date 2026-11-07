---
settings-section: Track 5 — operations
---

## changelog-en

### Per-role default tool lists: unused tool schemas leave the bot's request (TOOL-DIET-ROLES, OPE-11947)

- Every tool schema is sent on every model call. In a sample of 28k real requests of 21 bots, tools that were called
  less than 0.5 times per 100 requests still made up 5.5% of all request characters (engineers 6.4%, bbq bots 8.2%).
- The fleet list `MYRMIDON_BOT_DISABLED_TOOLS` now also holds `clarify` (the bots run behind the Hermes API server, which
  wires no clarify callback, so the tool only ever answers "not available") and `skill_manage` (unused; while it is
  present Hermes also adds its prompt guidance and forks a background skill review after every ten tool iterations).
- New role defaults on top of it, resolved from the agent's role (caste key) and card, never from the bot's name:
  roles `engineer`, `reviewer` and `release` (instance-configurable) lose the built-in `memory` tool and the Hindsight
  tools (the `memory` toolset is written to `agent.disabled_toolsets`; owner decision 26.10), the web tools, the browser
  tools and the image/media tools; every other role loses the browser and image/media tools.
- A card is never overridden against its will: a group stays when the card lists its toolset in `toolsets`
  (`memory`, `web`, `browser`, `browser-use`, `browser-cdp`, `image_gen`, ...); the new card key `keepTools` re-enables a
  group or a single tool (`["memory", "skill_manage"]`); the card's own `disabledTools` list still replaces every
  default list.
- A changed `config.yaml` restarts the bot container.

## changelog-ru

### Списки отключённых инструментов по ролям: неиспользуемые схемы уходят из запроса бота (TOOL-DIET-ROLES, OPE-11947)

- Схема каждого инструмента уходит в каждом вызове модели. В выборке из 28 тыс. реальных запросов 21 бота
  инструменты, которые вызывали реже 0,5 раза на 100 запросов, всё равно занимали 5,5% всех символов запроса
  (инженеры 6,4%, боты bbq 8,2%).
- Список парка `MYRMIDON_BOT_DISABLED_TOOLS` теперь включает ещё `clarify` (боты работают за API-сервером Hermes, который
  не подключает обработчик clarify, так что инструмент всегда отвечает «недоступно») и `skill_manage` (не используется;
  пока он есть, Hermes ещё добавляет его подсказку в системный промпт и после каждых десяти итераций инструментов
  запускает фоновый разбор навыков).
- Поверх него — умолчания по ролям, вычисляемые из роли агента (ключ касты) и его карточки, но не из имени бота:
  роли `engineer`, `reviewer` и `release` (настраивается на инстансе) теряют встроенный `memory` и инструменты Hindsight
  (набор `memory` пишется в `agent.disabled_toolsets`; решение владельца 26.10), веб-инструменты, инструменты браузера и
  инструменты изображений/медиа; остальные роли теряют инструменты браузера и изображений/медиа.
- Карточку это не переопределяет против её воли: группа остаётся, если карточка сама перечислила её набор в `toolsets`
  (`memory`, `web`, `browser`, `browser-use`, `browser-cdp`, `image_gen`, ...); новый ключ карточки `keepTools`
  возвращает группу или отдельный инструмент (`["memory", "skill_manage"]`); собственный список `disabledTools`
  карточки по-прежнему заменяет все списки по умолчанию.
- Изменение `config.yaml` перезапускает контейнер бота.

## settings-en

| `MYRMIDON_BOT_ROLE_TOOL_DIET` | TOOL-DIET-ROLES | unset (on) | Per-role default tool lists on top of `MYRMIDON_BOT_DISABLED_TOOLS`: developer roles lose `memory` (the toolset, with the Hindsight tools), the web, browser and image/media tools; every other role loses the browser and image/media tools. A card keeps what it lists in `toolsets` or in `keepTools`; its own `disabledTools` replaces every default list. A bot with no role gets no role defaults. The fleet default of `MYRMIDON_BOT_DISABLED_TOOLS` now also lists `clarify` and `skill_manage` | `off`, `0`, `false`, `no`, `none` or `-` switches the role defaults off (`MYRMIDON_BOT_DISABLED_TOOLS=none` does too). Read on every profile build; a change restarts the affected bot containers |
| `MYRMIDON_BOT_DEVELOPER_ROLES` | TOOL-DIET-ROLES | `engineer,reviewer,release` | Comma-separated caste keys (`agents.role`, case-insensitive) that get the developer tier of the role defaults. A role is matched by this key only, never by an agent's name | `none` (also `off`, `-`) leaves no developer role. A list with no usable key falls back to the default. Read on every profile build; a change restarts the affected bot containers |

## settings-ru

| `MYRMIDON_BOT_ROLE_TOOL_DIET` | TOOL-DIET-ROLES | не задано (включено) | Списки отключённых инструментов по ролям поверх `MYRMIDON_BOT_DISABLED_TOOLS`: роли разработки теряют `memory` (набор целиком, вместе с инструментами Hindsight), веб-инструменты, инструменты браузера и изображений/медиа; остальные роли теряют инструменты браузера и изображений/медиа. Карточка сохраняет то, что перечислила в `toolsets` или в `keepTools`; её собственный `disabledTools` заменяет все списки по умолчанию. Бот без роли не получает умолчаний по ролям. Умолчание `MYRMIDON_BOT_DISABLED_TOOLS` теперь включает ещё `clarify` и `skill_manage` | `off`, `0`, `false`, `no`, `none` или `-` выключает умолчания по ролям (`MYRMIDON_BOT_DISABLED_TOOLS=none` тоже). Читается при каждой сборке профиля; изменение перезапускает затронутые контейнеры ботов |
| `MYRMIDON_BOT_DEVELOPER_ROLES` | TOOL-DIET-ROLES | `engineer,reviewer,release` | Ключи каст через запятую (`agents.role`, без учёта регистра), которым достаётся уровень разработки в умолчаниях по ролям. Роль сопоставляется только по этому ключу, никогда по имени агента | `none` (также `off`, `-`) — ни одной роли разработки. Список без пригодного ключа возвращается к умолчанию. Читается при каждой сборке профиля; изменение перезапускает затронутые контейнеры ботов |
