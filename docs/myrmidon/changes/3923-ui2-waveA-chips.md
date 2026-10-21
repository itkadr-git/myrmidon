## changelog-en

### UI-2.0 Wave A part 2: live API top-bar chips and shell language preference (Refs OPE-3986, OPE-7936)

- Top-bar status chips wired to live APIs:
  - Colony chip shows running agents out of active colony (`running / (active + running + paused + error)` from `dashboard.agents`).
  - Runs chip shows live runs count (`queued + running` from `live-runs`) and today's UTC failures (`runActivity[today].failed`), with an attention tone when failures occur.
  - Spend chip displays current month spend from `costs/summary`; suppresses misleading "of $0" when budget is unset (`budgetCents = 0`).
  - "Wait for me" badge counts the owner-facing union of pending approvals, open decisions, and pending interactions.
  - Fail-closed behavior: unresolved sources render `—`; chips refetch every 30 seconds and on window focus.
- Shell language defaults to `en` for new users:
  - Dynamic locale switching to `ru` without a page reload, updating i18next, flat catalog, and the root `lang` attribute.
  - Personal language choice persists in `localStorage` and via `PUT /api/myrmidon/ui2/language/me`, syncing across browser tabs and surviving re-login.
  - Synchronized `ui2.chip` keys across all 40 locale JSON catalogs with full schema parity and `no-english-in-ru` guard compliance.

## changelog-ru

### UI-2.0 Волна A ч.2: чипы шапки на живых API и выбор языка оболочки (Refs OPE-3986, OPE-7936)

- Чипы статуса верхней панели переведены на живые API:
  - Чип «Колония» отображает число работающих агентов от общего числа активных (`running / (active + running + paused + error)` из `dashboard.agents`).
  - Чип «Прогоны» отображает живые прогоны (`queued + running` из `live-runs`) и сбои за сегодня по UTC (`runActivity[today].failed`), с тоном внимания при сбоях.
  - Чип «Расход» выводит сумму расходов за месяц из `costs/summary`; при нулевом бюджете (`budgetCents = 0`) отображает только сумму расхода без «из $0».
  - Бейдж «Ждёт меня» суммирует ожидающие подтверждения, открытые решения и взаимодействия.
  - Отказоустойчивое состояние: недоступные источники выводят `—`; чипы опрашиваются каждые 30 секунд и при возврате фокуса в окно.
- Язык оболочки по умолчанию для новых пользователей — `en`:
  - Динамическое переключение на `ru` без перезагрузки страницы с обновлением i18next, плоского каталога и корневого атрибута `lang`.
  - Выбор языка сохраняется в `localStorage` и через `PUT /api/myrmidon/ui2/language/me`, синхронизируется между вкладками и сохраняется при повторном входе.
  - Ключи `ui2.chip` синхронизированы во всех 40 файлах локалей JSON с сохранением паритета схемы и соблюдением проверки `no-english-in-ru`.
