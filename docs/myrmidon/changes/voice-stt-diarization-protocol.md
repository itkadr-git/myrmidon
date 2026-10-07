---
divergence-section: 1.6.1 — VOICE-STT: серверное ядро распознавания речи (часть A)
---

## changelog-en

### VOICE-STT part B: speaker diarization and the meeting protocol (VOICE-STT-B)

- The recognition path now answers the speaker-label outcome as a value: which
  call asked for diarization, whether the answer carried labels, how many
  speakers it found and, when labels are missing, the stable marker
  `diarization_no_speakers`. The LiteLLM/DashScope path asks the model for
  labels the way the Deepgram path already did — with the setting on, a
  recording with two voices comes back as «Говорящий 1/2» lines.
- A model that cannot separate voices is no longer a silent single-voice
  transcript: the task comment carries the marker line «Говорящие не размечены:
  diarization_no_speakers», and the meeting protocol reports the participants
  as unmarked instead of naming one.
- The work bot builds the meeting protocol from the labeled transcript — a
  deterministic pass (participants, decisions, action items) exposed as the
  function `buildMeetingProtocol` and as
  `POST /api/myrmidon/companies/:companyId/voice-meeting-protocol`, which
  answers the ready markdown document plus the facts it was built from. Naming
  the people behind «Говорящий N» stays with the bot's own meeting skill.

## changelog-ru

### VOICE-STT, часть B: разметка говорящих и протокол встречи (VOICE-STT-B)

- Путь распознавания теперь сообщает итог разметки значением: был ли запрошен
  разбор по говорящим, пришли ли метки, сколько говорящих нашлось и, если меток
  нет, — стабильную пометку `diarization_no_speakers`. Путь LiteLLM/DashScope
  просит метки у модели так же, как уже делал путь Deepgram: при включённой
  настройке запись с двумя голосами приходит строками «Говорящий 1/2».
- Модель, которая не умеет разделять голоса, больше не даёт молчаливый
  одно-голосый транскрипт: в комментарии задачи появляется строка-пометка
  «Говорящие не размечены: diarization_no_speakers», а протокол встречи
  сообщает, что участники не размечены, вместо того чтобы назвать одного.
- Бот work собирает протокол встречи из размеченного текста — детерминированным
  проходом (участники, решения, задачи), доступным как функция
  `buildMeetingProtocol` и как
  `POST /api/myrmidon/companies/:companyId/voice-meeting-protocol`, который
  отвечает готовым markdown-документом и фактами, из которых он собран. Имена
  людей за «Говорящий N» остаются за навыком встречи самого бота.

## divergence

| 1.6.5 VOICE-STT B (говорящие и протокол) | Разметка говорящих доведена до явного итога и появился протокол встречи. Ядро STT возвращает `SttResult.diarization` (`requested`, `applied`, `speakers`, стабильная причина `diarization_disabled` / `diarization_no_speakers`): путь LiteLLM/DashScope просит метки полем `diarization_enabled` (как путь Deepgram — `diarize`) и понимает все три написания метки (`speaker`, `speaker_id`, `speaker_label`); «просили, но меток нет» — это пометка `diarization_no_speakers`, а не молчаливый одно-голосый транскрипт. Приём дописывает в тело комментария строку «Говорящие не размечены: <код>», когда разметка была запрошена и не пришла. Протокол встречи для бота work — новый модуль `server/src/myrmidon/voice-meeting-protocol/`: `buildMeetingProtocol` разбирает размеченный текст («Говорящий N [mm:ss]: …» или сегменты ядра) и достаёт участников, решения и задачи детерминированным проходом (маркеры в начале строки, затем глагольные подсказки RU/EN, приоритет описан в файле), `renderMeetingProtocol` собирает markdown; `POST /api/myrmidon/companies/:companyId/voice-meeting-protocol` (company access: доска или агент своей компании, `validate` + `.strict()`, только чтение — ничего не пишет и не журналит) отвечает документом и фактами. Пустые списки и отсутствие разметки называются словами, а не пропуском | Наши файлы: `server/src/myrmidon/stt/{diarization.ts, diarization.myrmidon.test.ts}` (новые), `server/src/myrmidon/stt/{types,service,backend-dashscope,index}.ts` (дополнения), `server/src/myrmidon/telegram-voice-stt-intake/{transcript.ts, wiring.ts, index.ts}` (метка разметки), `server/src/myrmidon/voice-meeting-protocol/{labeled,protocol,index}.ts` + два сьюта (новые). Вендор: `server/src/app.ts` (импорт + `api.use` с меткой `myrmidon(1.6.5 VOICE-STT B)`) | Функция 1.6.5 VOICE-STT, часть B (говорящие и протокол встречи). Ядро части A1 умело диаризацию только на Deepgram-пути и не сообщало итог значением, а протокола встречи в коде не было вовсе | `diarization.myrmidon.test.ts` (итог разметки: применилась/нет/выключена; поле `diarization_enabled` в запросе ровно при включённой настройке; запись с двумя голосами даёт метки 1/2 через сервис над поддельным шлюзом; написания `speaker_id`/`speaker_label`; «модель не умеет» → явная пометка), `protocol.myrmidon.test.ts` (участники/решения/задачи из размеченного текста и из сегментов; метка отсутствия разметки; пустые списки словами; дедупликация и потолок списков; RU/EN подсказки), `routes.myrmidon.test.ts` (доска и агент своей компании — 200, чужой агент — 403, пустой текст и лишнее поле — 400), `transcript.myrmidon.test.ts` (строка-пометка в теле комментария) | Никогда, наше поведение (вендор не даёт ни меток говорящих, ни протокола встречи). При переносе сохранить куски с меткой `myrmidon(1.6.5 VOICE-STT B)`; при появлении собственного API диаризации у вендора сверить контракт и заменить вызов ядра | (этот PR) |
## settings-en-replace

| `MYRMIDON_STT_DIARIZATION` | 1.6.5 VOICE-STT B | unset (off) | Turns on speaker diarization on both backends: the Deepgram path sends `diarize`, the LiteLLM/DashScope path sends `diarization_enabled`. The answer always reports what happened — requested, applied, the speaker count, or the stable marker `diarization_no_speakers` — the intake writes the marker line «Говорящие не размечены» into the task comment, and the meeting protocol says the participants are unmarked. Speakers are never invented | Exact `0`/`false`/`no`/`off` — off |

## settings-ru-replace

| `MYRMIDON_STT_DIARIZATION` | 1.6.5 VOICE-STT B | не задано (выкл.) | Включает диаризацию говорящих на обоих бэкендах: путь Deepgram шлёт `diarize`, путь LiteLLM/DashScope — `diarization_enabled`. Ответ всегда сообщает, что получилось: запрошено ли, применилось ли, сколько говорящих или стабильная пометка `diarization_no_speakers`; приём пишет в комментарий строку «Говорящие не размечены», а протокол встречи сообщает, что участники не размечены. Спикеры никогда не выдумываются | Точные `0`/`false`/`no`/`off` — выкл. |
