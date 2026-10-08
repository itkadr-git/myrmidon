## divergence-new

<!-- after: 1.6.1 — экран «Model providers» (MODEL-PROVIDERS, часть C: UI) -->

### 1.6.1 — экран «Speech recognition» (VOICE-STT, часть C: UI)

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.1-VOICE-STT-C | Экран «Speech recognition» в Company Settings (`/company/settings/voice-stt`, пункт «Speech» в CompanySettingsNav после Castes & models): включение STT, провайдер (dashscope/deepgram), имя модели на шлюзе, язык (auto/ru), флаг diarization, лимит длительности в секундах. Сохранение шлёт только изменённые поля (diff-правило), очистка модели шлёт null. Имена секретов и baseUrl экраном не правятся (инстансный контур настроек); значения секретов в UI не приходят и не рендерятся. Контракт — API ядра A1 (в 1.6.5 уже влит): GET/PATCH `/api/myrmidon/companies/:id/voice-stt`; файлы сервера не тронуты | Наши файлы: `ui/src/components/myrmidon/voice-stt/{VoiceSttScreen.tsx,VoiceSttContainer.tsx,voiceSttApi.ts}` и оба теста; в вендоре помечены `myrmidon(1.6.1 VOICE-STT C)`: `ui/src/App.tsx` (один импорт + один маршрут), `ui/src/components/access/CompanySettingsNav.tsx` (пункт + активная секция), `ui/src/components/access/CompanySettingsNav.test.tsx` (ожидание пункта), `ui/src/i18n/locales/*.json` (неймспейс `voiceStt`: EN в en, RU в ru, английский текст в остальных — паритет ключей держит вендорский валидатор) | 1.6.1 VOICE-STT: оператор включает и настраивает распознавание голосовых из Telegram в UI доски; экран говорит с контрактом ядра A1 | `VoiceSttScreen.myrmidon.test.tsx` (view-ярус: рендер всех полей, edit-обработчики, diff-правило сохранения, null при очистке, индикатор задан/не задан по загруженной записи, сброс формы после сохранения, баннер ошибки, DOM без секрет-подобных значений) + `VoiceSttContainer.myrmidon.test.tsx` (wire-ярус: GET запись, PATCH только изменённых полей, ошибка мутации текстом, имена секретов рендерятся, значений в DOM нет) | Никогда, наше поведение. Уходит вместе с ядром A1: удалить каталог, пункт навигации, маршрут и неймспейс | (этот PR) |


## changelog-en

### VOICE-STT part C: the speech recognition settings screen (VOICE-STT-C)

- Company Settings gets a "Speech" screen (`/company/settings/voice-stt`): enable
  recognition, pick the provider (DashScope or Deepgram), the model, the
  language (auto or Russian), speaker separation and the recording length limit.
  Only changed fields are saved. Secret values never reach the screen.

## changelog-ru

### VOICE-STT часть C: экран настроек распознавания речи (VOICE-STT-C)

- В настройках компании появился экран «Speech» (`/company/settings/voice-stt`):
  включение распознавания, провайдер (DashScope или Deepgram), модель, язык
  (авто или русский), разделение говорящих и лимит длительности записи.
  Сохраняются только изменённые поля. Значения секретов на экран не приходят.
