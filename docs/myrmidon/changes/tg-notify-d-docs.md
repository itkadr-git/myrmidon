## settings-en-new

<!-- after: 1.6.1 — TG-NOTIFY head-bot proactivity (part E: gate, rarely limit, U2 bundling) -->
### 1.6.1 — TG-NOTIFY topic inbound (part D: Telegram group topics as a task inbox)

Settings of `server/src/myrmidon/telegram-notify/topic-inbound*.ts` (the
inbound half of the TG-NOTIFY-SETTINGS epic, part D). A message in a forum
topic of a connected Telegram group can become task work: the board continues
the conversation already bound to that topic or creates a task whose title is
the first words of the message and whose body carries the full text plus the
link to the Telegram thread. Both switches are off by default — with the
defaults the vendor path is byte-for-byte unchanged. Runtime-changeable, no
restart: the values live in the `inbound` area of the `telegramNotify`
settings document (the contract and defaults are defined in
`packages/shared/src/myrmidon-telegram-notify.ts`). The operator-facing guide
is [telegram-topic-inbound.md](../guides/telegram-topic-inbound.md).

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `telegramNotify.inbound.enabled` (settings area) | 1.6.1-TG-NOTIFY-D | `false` | Master switch of topic inbound: an admitted message in a Telegram forum topic continues the task already bound to that topic, or creates a new task with the message's first words as the title and the thread link in the body | Read from the settings document on every inbound topic message. Only `true` enables; anything else (absent, malformed, another value) reads as off and the vendor path is untouched |
| `telegramNotify.inbound.requireMention` (settings area) | 1.6.1-TG-NOTIFY-D | `true` | With inbound enabled, a topic message the adapter did not mark as a mention or a reply to the bot stays ignored — the group privacy contract, so commands in a topic work only when the bot is addressed, as in a DM | `false` admits any topic message, as in a DM. Any value that is not a boolean falls back to `true` |

## settings-ru-new

<!-- after: 1.6.1 — TG-NOTIFY-SETTINGS, часть F: UI доски для настроек Telegram-уведомлений -->
### 1.6.1 — TG-NOTIFY topic inbound (часть D: топики Telegram-группы как входящие задач)

Настройки `server/src/myrmidon/telegram-notify/topic-inbound*.ts` (входящая
половина эпика TG-NOTIFY-SETTINGS, часть D). Сообщение в топике форума
подключённой Telegram-группы может стать работой: доска продолжает беседу,
уже связанную с этим топиком, или создаёт задачу, у которой заголовок —
первые слова сообщения, а в теле — полный текст со ссылкой на ветку Telegram.
Оба переключателя по умолчанию выключены — с умолчаниями путь вендора не
меняется ни на байт. Меняются на лету, без перезапуска: значения живут в
области `inbound` документа настроек `telegramNotify` (контракт и умолчания
определены в `packages/shared/src/myrmidon-telegram-notify.ts`).
Руководство для оператора —
[telegram-topic-inbound.ru.md](../guides/telegram-topic-inbound.ru.md).

| Переменная | Функция | Умолчание | Что делает | Как выключить / особенность |
|---|---|---|---|---|
| `telegramNotify.inbound.enabled` (область настроек) | 1.6.1-TG-NOTIFY-D | `false` | Главный выключатель topic inbound: допущенное сообщение в топике форума Telegram продолжает задачу, уже связанную с этим топиком, или создаёт новую задачу с первыми словами сообщения в заголовке и ссылкой на ветку в теле | Читается из документа настроек на каждое входящее сообщение топика. Включает только `true`; всё остальное (отсутствует, испорчено, другое значение) читается как выключено, путь вендора не затрагивается |
| `telegramNotify.inbound.requireMention` (область настроек) | 1.6.1-TG-NOTIFY-D | `true` | При включённом inbound сообщение топика, которое адаптер не пометил как упоминание бота или ответ ему, остаётся проигнорированным — контракт приватности групп: команды в топике работают только при обращении к боту, как в личке | `false` пропускает любое сообщение топика, как в личке. Любое небулево значение откатывается к `true` |

## changelog-en

### Telegram group topics as a task inbox (TG-NOTIFY part D)

- A message in a forum topic of a connected Telegram group can now become
  work on the board: the message continues the task already bound to that
  topic, or a new task is created with the first words of the message as the
  title and the thread link in the body. Both switches
  (`telegramNotify.inbound.enabled`, `telegramNotify.inbound.requireMention`)
  are off by default; the require-mention default keeps the group privacy
  contract, so commands in a topic work only when the bot is addressed. See
  [telegram-topic-inbound](../guides/telegram-topic-inbound.md).

## changelog-ru

### Топики Telegram-группы как входящие задач (TG-NOTIFY, часть D)

- Сообщение в топике форума подключённой Telegram-группы теперь может стать
  работой на доске: оно продолжает задачу, уже связанную с этим топиком, либо
  создаётся новая задача с первыми словами сообщения в заголовке и ссылкой на
  ветку в теле. Оба переключателя (`telegramNotify.inbound.enabled`,
  `telegramNotify.inbound.requireMention`) по умолчанию выключены; умолчание
  «требовать упоминание» сохраняет контракт приватности групп — команды в
  топике работают только при обращении к боту. См.
  [telegram-topic-inbound](../guides/telegram-topic-inbound.md).
