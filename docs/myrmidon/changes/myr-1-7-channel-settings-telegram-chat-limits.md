## changelog-en

### Channel settings: the Telegram bridge and the chat limits without a restart (SETTINGS-TO-UI)

- `GET /api/myrmidon/channel-settings` reports the effective value of every
  channel setting — the Telegram DM bridge list and status, the split and
  attachment limits, the cross-channel numbers and the chat reconcile interval —
  together with where each value came from (`ui` for the stored document, `env`
  for the deployment environment, `default` for the built-in fallback) and
  whether the environment pins it.
- `PATCH /api/myrmidon/channel-settings` (instance admin only) writes
  `instance_settings.general.channelSettings`, records the change in the activity
  log for every company and answers with the settings now in force. The
  deployment environment keeps winning over a stored value: a set `MYRMIDON_*`
  variable stays the forced override and the answer marks the key `overridden`.
- The document is registered in the instance settings contract
  (`instance_settings.general.channelSettings`), so the stored value survives a
  read-write of the general block instead of being dropped as an unknown key.

## changelog-ru

### Настройки каналов: Telegram-мост и лимиты чата без перезапуска (SETTINGS-TO-UI)

- `GET /api/myrmidon/channel-settings` возвращает действующее значение каждой
  настройки каналов — список и статус DM-моста Telegram, лимиты частей и
  вложений, числа цитирования соседних каналов и интервал сверки чата — вместе с
  источником значения (`ui` — сохранённый документ, `env` — окружение
  развёртывания, `default` — встроенное умолчание) и признаком того, что значение
  пришпилено окружением.
- `PATCH /api/myrmidon/channel-settings` (только администратор инстанса) пишет
  `instance_settings.general.channelSettings`, записывает изменение в журнал
  активности по каждой компании и отвечает действующими настройками. Окружение
  по-прежнему важнее сохранённого значения: выставленная переменная `MYRMIDON_*`
  остаётся принудительным переопределением, и ответ помечает такой ключ
  `overridden`.
- Документ зарегистрирован в контракте настроек инстанса
  (`instance_settings.general.channelSettings`), поэтому сохранённое значение
  выживает чтение-запись общего блока, а не отбрасывается как неизвестный ключ.