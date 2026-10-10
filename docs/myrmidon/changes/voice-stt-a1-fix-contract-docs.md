## changelog-en

### Voice STT runtime settings: full contour over the API (VOICE-STT A1-fix)

- `PATCH /api/myrmidon/companies/:companyId/voice-stt` now accepts `baseUrl`,
  `keySecret` and `deepgramKeySecret` on top of the previous fields
  (`enabled`, `backend`, `model`, `language`, `diarization`,
  `maxDurationSec`): the whole STT contour (gateway/Deepgram address and the
  secret names) can be set per company without an env change or a restart.
  The fields share the null-semantics of `model`: an explicit `null` clears
  the stored value back to the environment default, an omitted field keeps
  the current one. The GET response (the `settingsView`) keeps `baseUrl` but
  does not return `keySecret` / `deepgramKeySecret` — secret names are
  write-only over the API, secret values are never returned. See
  [SETTINGS.md](SETTINGS.md), the VOICE-STT section.

## changelog-ru

### Runtime-настройки распознавания голоса: весь контур через API (VOICE-STT A1-fix)

- `PATCH /api/myrmidon/companies/:companyId/voice-stt` теперь принимает
  `baseUrl`, `keySecret` и `deepgramKeySecret` вдобавок к прежним полям
  (`enabled`, `backend`, `model`, `language`, `diarization`,
  `maxDurationSec`): весь контур STT (адрес шлюза/Deepgram и имена секретов)
  настраивается на компанию без правки окружения и перезапуска. Поля
  разделяют null-семантику `model`: явный `null` очищает сохранённое значение
  обратно к умолчанию окружения, пропущенное поле сохраняет текущее. Ответ
  GET (представление `settingsView`) по-прежнему отдаёт `baseUrl`, но не
  отдаёт `keySecret` / `deepgramKeySecret` — имена секретов доступны по API
  только на запись, значения секретов не отдаются никогда. См.
  [SETTINGS.ru.md](SETTINGS.ru.md), секция VOICE-STT.

## settings-en-append

<!-- section: 1.6.1 — VOICE-STT (server-side speech-to-text core, part A) -->
Since the A1-fix, the PATCH also accepts `baseUrl` (a URL), `keySecret` and
`deepgramKeySecret` — each a non-empty string or `null`, with the same
null-semantics as `model` (explicit `null` clears the stored value back to
the environment default, an omitted field keeps the current one). The
`settingsView` returns `baseUrl` but omits `keySecret` and
`deepgramKeySecret`: the secret names are write-only over the API, and the
secret values are never returned. (The PATCH paragraph above in this section
still reads "accepts only …" — written before the A1-fix; the field list here
is the current one.)

## settings-ru-append

<!-- after-line: `problem` равен `null`, когда путь готов. -->
С A1-fix PATCH принимает также `baseUrl` (URL), `keySecret` и
`deepgramKeySecret` — каждое непустой строкой или `null`, с той же
null-семантикой, что у `model` (явный `null` очищает сохранённое значение
обратно к умолчанию окружения, пропущенное поле сохраняет текущее).
Представление `settingsView` отдаёт `baseUrl`, но не отдаёт `keySecret` и
`deepgramKeySecret`: имена секретов доступны по API только на запись, а
значения секретов не отдаются никогда. (Абзац выше всё ещё говорит
«принимает только …» — написан до A1-fix; актуальный список полей здесь.)
