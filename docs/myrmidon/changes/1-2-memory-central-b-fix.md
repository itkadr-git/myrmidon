---
divergence-section: Трек 3 — шлюз инструментов и адаптер Hermes
settings-section: Track 3 — tool gateway and Hermes adapter
---

## changelog-en

### Central session history for gateway bots (MEMORY-CENTRAL-B)

- A bot's conversation history can now live in the board's central hindsight
  store instead of the container volume: with `MYRMIDON_BOT_CENTRAL_HISTORY=1`
  (off by default) the Hermes gateway adapter saves the final output of every
  completed run as a session-turn record in the bot's own hindsight bank
  (documents keyed by the session key, tag `myrmidon-session-history`), and on
  the next wake of the same session restores the last turns (default 10, card
  field `centralHistoryMaxTurns`) into the wake input under a visible
  "restored conversation history" header. Recreating the container volume no
  longer loses the history: a rebuilt container reads its turns back from the
  central store.
- Resolution order for the store address, bank and key (first hit wins): the
  agent card fields `adapterConfig.centralHistoryUrl` / `centralHistoryBankId`
  / `centralHistoryApiKey` / `centralHistoryMaxTurns`, then
  `MYRMIDON_BOT_HINDSIGHT_API_URL` / `MYRMIDON_BOT_HINDSIGHT_BANK` /
  `MYRMIDON_HINDSIGHT_API_URL` / `HINDSIGHT_API_KEY` (the bot-env pair the
  profile compiler already injects), then the same names in the server process
  environment. The bank defaults to the card's `hindsight.bankId`.
- Off or unconfigured, every path is untouched vendor behavior: no requests,
  no logs beyond the normal ones. While on, a store failure never blocks a
  run — a failed read continues the wake without the restored block, a failed
  save is logged and the run result stays as it was. Only the redacted final
  output of the run is stored (the same redaction the run result already
  gets), and the restored block is bounded by turn count and size.
- New files: `packages/adapters/hermes/src/gateway/server/central-history.ts`
  and its suite; `execute.ts` only gains three marked call sites.

## changelog-ru

### Центральная история сессий для ботов шлюза (MEMORY-CENTRAL-B)

- История диалога бота может жить в центральном hindsight-хранилище доски, а
  не на томе контейнера: при `MYRMIDON_BOT_CENTRAL_HISTORY=1` (по умолчанию
  выключено) адаптер Hermes gateway сохраняет финальный вывод каждого
  завершённого прогона как запись хода сессии в собственный hindsight-банк
  бота (документы по ключу сессии, тег `myrmidon-session-history`), а при
  следующей побудке той же сессии поднимает последние ходы (по умолчанию 10,
  поле карточки `centralHistoryMaxTurns`) во вход побудки под видимым
  заголовком восстановленной истории. Пересоздание тома контейнера больше не
  теряет историю: пересобранный контейнер читает ходы из центра.
- Порядок разрешения адреса, банка и ключа (первое попадание): поля карточки
  `adapterConfig.centralHistoryUrl` / `centralHistoryBankId` /
  `centralHistoryApiKey` / `centralHistoryMaxTurns`, затем
  `MYRMIDON_BOT_HINDSIGHT_API_URL` / `MYRMIDON_BOT_HINDSIGHT_BANK` /
  `MYRMIDON_HINDSIGHT_API_URL` / `HINDSIGHT_API_KEY` (пара бот-энви, которую
  компилятор профиля уже инжектит), затем те же имена в окружении процесса
  сервера. Банк по умолчанию — `hindsight.bankId` из карточки.
- Выключено или не настроено — все пути остаются вендорскими: ни запросов, ни
  лишних логов. Включено — сбой хранилища никогда не блокирует прогон:
  неудачное чтение продолжает побудку без блока истории, неудачная запись
  логируется и результат прогона не меняется. Хранится только отредактированный
  финальный вывод прогона (то же редактирование, что и у результата), блок
  восстановления ограничен числом ходов и размером.
- Новые файлы: `packages/adapters/hermes/src/gateway/server/central-history.ts`
  и сьют; в `execute.ts` только три помеченных точки вызова.

## divergence

| MEMORY-CENTRAL-B | История сессий бота поверх вендорного шлюза: до сборки тела прогона читает из центрального hindsight-банка последние ходы сессии и дописывает блок восстановленной истории во вход побудки; после терминального исхода прогона сохраняет отредактированный финальный вывод как запись хода (document_id — ключ сессии, тег `myrmidon-session-history`). Всё за `MYRMIDON_BOT_CENTRAL_HISTORY` (выкл), при сбое хранилища прогон продолжается без записи/блока | `packages/adapters/hermes/src/gateway/server/execute.ts` (помечены `myrmidon(MEMORY-CENTRAL-B)`: импорт, создание клиента, чтение перед `buildRunBody`, запись после `mapFinalResultForTest`) | Том контейнера бота — эфемерный: пересоздание образа/тома теряло историю сессий, а hindsight-банк бота уже центральный и переживает пересоздание; минимальная правка — два вызова в существующем потоке шлюза без новых хранилищ и миграций | `packages/adapters/hermes/src/gateway/server/central-history.test.ts` (разбор настроек и приоритеты, флаг, ограничение ходами, повторный подъём с пустым томом читает историю из центра, best-effort запись) | Никогда, наше поведение. Снятие: удалить `central-history.ts` с тестом и три помеченных блока в `execute.ts`, строки SETTINGS/DIVERGENCE/CHANGELOG | (этот PR) |

## settings-en

| `MYRMIDON_BOT_CENTRAL_HISTORY` | MEMORY-CENTRAL-B | off | Turns on central session history for the Hermes gateway adapter: the run's final output is saved to the bot's hindsight bank and the last turns are restored into the wake input of the same session. Needs a resolvable store address and bank (card fields `centralHistoryUrl`/`centralHistoryBankId`/`centralHistoryApiKey`, or `MYRMIDON_BOT_HINDSIGHT_API_URL`/`MYRMIDON_BOT_HINDSIGHT_BANK`/`HINDSIGHT_API_KEY`; the bank falls back to the card's `hindsight.bankId`) — a truthy flag without address or bank stays disabled. `1`/`true`/`yes`/`on` enables | Do not set, or `0`/`false`/`off`/`no`. Disabled = byte-identical vendor behavior: no requests, no restored block, no save. Per card instead of env: `adapterConfig.centralHistory: "0"` is not a kill switch for the env flag — clear the env instead. `adapterConfig.centralHistoryMaxTurns` (1–50, default 10) bounds how many turns are restored |
