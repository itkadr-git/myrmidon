---
divergence-section: 1.6.1 — VOICE-STT: серверное ядро распознавания речи (часть A)
---

## changelog-en

### VOICE-STT part A: Telegram voice and audio are recognized at intake (VOICE-STT-A)

- The shared speech-to-text core (`server/src/myrmidon/stt/`) is now wired into
  the inbound Telegram lane: with the feature enabled, a voice note or audio
  file arrives as a task comment whose body carries the transcript next to the
  kept attachment, so the bot reads it as user input on the same wakeup.
- The feature can be enabled per company from the STT settings screen — no
  server restart: the stored setting is read on every voice message. The
  environment variable `MYRMIDON_TELEGRAM_VOICE_STT` stays the instance-wide
  master switch and, when it names a value, wins over the company setting in
  both directions.
- A recognition failure (gateway unavailable, recognition model not registered,
  timeout, oversized or too long recording) is a skip, never a delivery
  failure: the comment keeps the vendor body and its metadata carries the
  redacted `stt_skipped: <code>` code.

## changelog-ru

### VOICE-STT часть A: голосовые и аудио Telegram распознаются при приёме (VOICE-STT-A)

- Общее ядро распознавания речи (`server/src/myrmidon/stt/`) подключено к
  приёму Telegram: при включённой функции голосовое или аудио приходит
  комментарием задачи, в теле которого рядом с сохранённым вложением лежит
  транскрипт, — бот читает текст как пользовательский ввод в той же побудке.
- Функцию можно включить по компании из экрана настроек STT — без перезапуска
  сервера: сохранённая настройка читается на каждом голосовом сообщении.
  Переменная `MYRMIDON_TELEGRAM_VOICE_STT` остаётся общим выключателем
  инстанса и, когда задана, перекрывает настройку компании в обе стороны.
- Отказ распознавания (шлюз недоступен, модель распознавания не
  зарегистрирована, таймаут, слишком крупная или длинная запись) — пропуск, а
  не сбой доставки: комментарий сохраняет тело вендора, а в его метаданных
  остаётся редактированный код `stt_skipped: <код>`.

## divergence

| 1.6.5 VOICE-STT A (провод) | Замыкание шва части B: ядро STT подключено к приёму. `createTelegramVoiceSttWiring` собирает транскрибер (ядро за контрактом `TelegramVoiceTranscriber`) и гейт компании (env-выключатель, иначе сохранённая настройка компании) и передаётся в `chatChannelService` одной строкой в `app.ts`. Включённая функция распознаёт входящее голосовое/аудио Telegram при приёме: транскрипт — в теле комментария задачи рядом с сохранённым вложением; отказ распознавания — пропуск с редактированным кодом, доставка не страдает; по умолчанию (выключено, ноль переменных) путь вендора байт-в-байт | Вендор: `server/src/app.ts` (импорт + две опции `chatChannelService` с меткой `myrmidon(1.6.5 VOICE-STT A)`), `server/src/services/chat-channels.ts` (опция `telegramVoiceSttCompanyEnabled` и её чтение в одной точке с меткой `myrmidon(1.6.5 VOICE-STT A)`). Наши файлы: `server/src/myrmidon/telegram-voice-stt-intake/wiring.ts`, расширения `index.ts`/`settings.ts` того же модуля (опциональное поле `companyEnabled`, трёхзначный разбор env-выключателя) | Функция 1.6.5 VOICE-STT, часть A (приём и распознавание). Часть B объявлена со швом и мок-ядром до мержа A1, поэтому включённая настройка давала пропуск `stt_unconfigured` — функция не работала | `server/src/myrmidon/telegram-voice-stt-intake/wiring.myrmidon.test.ts` (гейт: env перекрывает настройку компании в обе стороны, иначе решает настройка компании, нечитаемая настройка — «нет ответа»; адаптер: результат ядра маппится 1:1, код ошибки ядра сохраняется; end-to-end по РЕАЛЬНОМУ ядру с поддельным шлюзом: ogg-голосовое без MIME → текст в теле комментария, вложение сохранено; 502 → пропуск без исключения и без утечки ключа; «Invalid model name» → `stt_unconfigured`; выключено → ноль загрузок и ноль вызовов), `intake.myrmidon.test.ts` (настройка компании при пустом env; env перекрывает компанию), `server/src/__tests__/chat-channels.integration.test.ts` (кейсы `company_enabled` и `company_off`) | Никогда, наше поведение (вендор не распознаёт аудио при приёме). Снять: удалить `wiring.ts` и его реэкспорт из `index.ts`, метки `myrmidon(1.6.5 VOICE-STT A)` в `app.ts` и `chat-channels.ts`, вернув шов части B без гейта компании | (этот PR) |

## settings-en-replace

| `MYRMIDON_TELEGRAM_VOICE_STT` | 1.6.5 VOICE-STT A | off | Transcribe an inbound Telegram voice/audio message at intake: the bytes are prefetched (bounded, 20 MB, 45 s), recognized through the shared STT core and the transcript is written into the task comment next to the kept attachment — the bot reads it as user input on the same wakeup. Speaker segments render as «Говорящий N [mm:ss]: …». An STT failure is a skip: the comment keeps the vendor body, the redacted `stt_skipped` code lands in the comment metadata, and the delivery is unaffected | Any value other than `1`/`true`/`yes`/`on` — the vendor path byte for byte: no byte prefetch, zero calls to the transcription core. Read per delivery, no restart. Set here it is the instance master switch and wins over the company setting in both directions; unset (or an unrecognized value), the company's own switch saved on the STT settings screen decides, so the feature can be enabled per company without a restart. Until the recognition model and the key secret are named (see the STT settings), an enabled turn records the stable `stt_unconfigured` skip |
## settings-ru-append

<!-- section: Трек 4 — чаты и навыки -->
| `MYRMIDON_TELEGRAM_VOICE_STT` | 1.6.5 VOICE-STT A | выкл. | Распознавание входящего голосового/аудио Telegram при приёме: байты префетчатся (до 20 МБ, 45 с), распознаются общим ядром STT, транскрипт ложится в тело комментария задачи рядом с сохранённым вложением — бот читает его как пользовательский ввод в той же побудке. Сегменты рендерятся как «Говорящий N [mm:ss]: …». Отказ STT — пропуск: комментарий сохраняет тело вендора, в его метаданных остаётся редактированный код `stt_skipped`, доставка не страдает | Любое значение, кроме `1`/`true`/`yes`/`on` — путь вендора байт-в-байт: ни префетча, ни вызовов ядра. Читается на каждую доставку, без перезапуска. Заданная здесь переменная — общий выключатель инстанса и перекрывает настройку компании в обе стороны; если она не задана (или значение не распознано), решает выключатель компании с экрана настроек STT — функцию можно включить по компании без перезапуска. Пока не названы модель распознавания и секрет ключа (см. настройки STT), включённый ход даёт стабильный пропуск `stt_unconfigured` |
