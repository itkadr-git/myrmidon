---
settings-section: 1.6.1 — BOT-DISK B: shared package cache for bot containers
---

## changelog-en

### A bot can no longer fill the host disk (1.6.1-BOT-DISK-C)

- Per-bot disk quota: instance setting `general.botDiskQuota` — a default in MB
  for every bot, per-caste (`agents.role`) and per-bot overrides, plus a
  `container.diskQuotaMb` override on the bot card (it wins). Set in the panel on
  the instance general settings page or through `GET`/`PATCH /api/myrmidon/bot-disk-quota`
  (instance admins only); applies without a restart.
- Usage is the bot's own volume `<MYRMIDON_BOT_VOLUME_ROOT>/<botKey>` (hermes,
  workspace, scratch), measured by the maintenance-tick sweep one page of bots
  per tick; a hard-linked pnpm store counts once per bot, deep or huge volumes
  stop at caps and report a lower bound.
- Approaching (>=80%) or exceeding the quota raises an attention card
  (`bot_disk_quota`) on the board's attention queue; while a bot is over quota a
  NEW execution workspace clone is refused before its directory is created, and
  the bot sees `BOT_DISK_QUOTA_EXCEEDED:` with its usage, the limit and the setting
  to fix. Existing workspaces keep working; deleting old drafts frees room.
- With no `MYRMIDON_BOT_VOLUME_ROOT` on the board's host, or no quota saved, the
  feature is inert: no measurement, no card, no refusal. Details:
  [bot-disk-quota.md](bot-disk-quota.md) / [bot-disk-quota.ru.md](bot-disk-quota.ru.md).

## changelog-ru

### Бот больше не может заполнить диск хоста (1.6.1-BOT-DISK-C)

- Квота диска на бота: настройка экземпляра `general.botDiskQuota` — умолчание в
  МБ для всех, переопределения по касте (`agents.role`) и по боту, плюс
  `container.diskQuotaMb` на карточке бота (он выше всех). Задаётся в панели на
  странице общих настроек экземпляра или через `GET`/`PATCH /api/myrmidon/bot-disk-quota`
  (только администраторы экземпляра); применяется без перезапуска.
- Учитывается объём самого бота `<MYRMIDON_BOT_VOLUME_ROOT>/<botKey>` (hermes,
  workspace, scratch); сметчик в такте обслуживания измеряет одну страницу ботов
  за такт; жёсткие ссылки общего хранилища pnpm считаются один раз на бота,
  глубокие или огромные тома останавливаются на лимитах обхода и дают нижнюю
  границу.
- При приближении (>=80%) или превышении квоты на доску поднимается карточка
  внимания (`bot_disk_quota`); пока бот сверх квоты, НОВЫЙ клон рабочего
  каталога отклоняется до создания каталога, и бот видит `BOT_DISK_QUOTA_EXCEEDED:`
  с использованием, лимитом и настройкой для исправления. Существующие рабочие
  каталоги продолжают работать; удаление старых черновиков освобождает место.
- Без `MYRMIDON_BOT_VOLUME_ROOT` на хосте доски или без сохранённой квоты
  функция молчит: нет измерения, карточек и отказов. Подробности:
  [bot-disk-quota.ru.md](bot-disk-quota.ru.md).

## settings-en

| `general.botDiskQuota` | 1.6.1-BOT-DISK-C | unset (quota off) | Per-bot disk quota in MB: `defaultQuotaMb` for every bot, `perCaste[]` (`{casteKey, quotaMb}` matched against `agents.role`) and `perAgent[]` (`{agentKey, quotaMb}`, wins over the caste entry); a bot card's `container.diskQuotaMb` wins over all of them. The measured usage is the bot's own volume `<MYRMIDON_BOT_VOLUME_ROOT>/<botKey>` (hermes, workspace, scratch). A bot at >=80% of its quota raises an attention card (`bot_disk_quota`); over it, a NEW workspace clone is refused before the directory is created with the `BOT_DISK_QUOTA_EXCEEDED:` message. Saved in the instance settings (`PATCH /api/myrmidon/bot-disk-quota`, instance admins only, audited as `instance.bot_disk_quota.updated`); the settings panel is on the instance general settings page. Applies without a restart: the sweep re-reads the values at the top of every maintenance tick and the admission check reads them per request | `null`/`{}` — off; `defaultQuotaMb: null` with empty lists — off even if overrides existed. An invalid stored value reads as off (fail-closed, no card can be raised by a broken setting). No-op without `MYRMIDON_BOT_VOLUME_ROOT` on the board's host |

## settings-ru

| `general.botDiskQuota` | 1.6.1-BOT-DISK-C | не задано (квота выключена) | Квота диска на бота в МБ: `defaultQuotaMb` для всех, `perCaste[]` (`{casteKey, quotaMb}`, совпадение по `agents.role`) и `perAgent[]` (`{agentKey, quotaMb}`, выше касты); `container.diskQuotaMb` карточки бота выше всего. Учитывается объём самого бота `<MYRMIDON_BOT_VOLUME_ROOT>/<botKey>` (hermes, workspace, scratch). Бот на >=80% квоты поднимает карточку внимания (`bot_disk_quota`); сверх квоты НОВЫЙ клон рабочего каталога отклоняется до создания каталога с сообщением `BOT_DISK_QUOTA_EXCEEDED:`. Хранится в настройках экземпляра (`PATCH /api/myrmidon/bot-disk-quota`, только администраторы экземпляра, аудит `instance.bot_disk_quota.updated`); панель — на странице общих настроек экземпляра. Применяется без перезапуска: сметчик перечитывает значения в начале каждого такта обслуживания, проверка приёма — на каждый запрос | `null`/`{}` — выключено; `defaultQuotaMb: null` с пустыми списками — выключено. Неверное сохранённое значение читается как выключено (fail-closed: сломанная настройка не поднимет карточку). Без `MYRMIDON_BOT_VOLUME_ROOT` на хосте доски не действует |
