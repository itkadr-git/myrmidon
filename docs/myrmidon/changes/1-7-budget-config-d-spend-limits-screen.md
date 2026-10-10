## changelog-en

### The spend limits screen (1.7 BUDGET-CONFIG D)

- Company settings → Budgets is where the owner reads and edits the spend
  limits of the hierarchy: nest (the whole company and each project) → caste →
  foraging → task, one row per level with its amount, period, mode and the
  spend of the period against the limit (`$600.00 / $500.00 (120% used)`,
  marked when the limit is crossed). Editing is in place — change the amount,
  the period or the mode and press Save on that row; a row without a limit is
  created right there, and a stored one can be removed (its history stays).
- The switch at the top is the global "signal only" mode; the screen shows the
  effective value **and where it comes from** (default / saved / forced by the
  server environment, in which case the switch is locked). Everything writes
  straight to the running API: no restart, no page reload — the row, its spend
  and the journal entry refresh from the server.
- The bottom table is the change journal: who, when, what (created / updated /
  deleted), which level and value, and the amount move. Guide:
  [guides/budget-limits-ui.md](guides/budget-limits-ui.md).


## changelog-ru

### Экран лимитов расхода (1.7 BUDGET-CONFIG D)

- «Настройки компании → Бюджеты» — место, где владелец смотрит и правит
  лимиты расхода по иерархии: гнездо (вся компания и каждый проект) → каста →
  фуражировка → задача; по строке на уровень с суммой, периодом, режимом и
  расходом периода против лимита (`$600.00 / $500.00 (120% израсходовано)`, с
  пометкой при превышении). Правка идёт на месте: меняете сумму, период или
  режим и нажимаете «Сохранить» в строке; строка без лимита создаётся тут же,
  сохранённый лимит можно удалить (история остаётся).
- Переключатель сверху — глобальный режим «только сигнал»: экран показывает и
  действующее значение, и **откуда оно взято** (умолчание / сохранено /
  задано переменной окружения — тогда переключатель заблокирован). Всё
  записывается прямо в работающий API: без перезапуска и без перезагрузки
  страницы — строка, расход и запись журнала обновляются с сервера.
- Нижняя таблица — журнал изменений: кто, когда, что (создан / изменён /
  удалён), какой уровень и значение и как изменилась сумма. Гайд:
  [guides/budget-limits-ui.ru.md](guides/budget-limits-ui.ru.md).


## settings-en-new

<!-- after: 1.7 — BUDGET-CONFIG B: enforcement mode of spend limits -->
### 1.7 — BUDGET-CONFIG D: the "Budgets" screen and the limits it edits

The screen at Company settings → Budgets (`/company/settings/budgets`, guide
[guides/budget-limits-ui.md](guides/budget-limits-ui.md)) is where the owner
sets and changes the per-level spend limits, sees the spend against each limit,
turns the global "signal only" mode on or off and reads the change journal. It
adds **no environment variable of its own**: every knob it writes is a live
setting — change it on the screen and the running API applies it with no
restart and no page reload. The one environment variable in play is the forced
override of the signal-only value, named by part A
([guides/budget-limits.md](guides/budget-limits.md)); the screen shows the
source of the effective value and locks its switch while the environment forces
it.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| — (no variable) | 1.7-BUDGET-CONFIG-D | — | The per-level limits (amount, period, hard/soft) live in the `budget_limits` table and the global signal-only flag in `instance_settings.general.budgetLimits` (both part A, OPE-4161). The screen edits them in place: a saved row, its spend and its journal entry refresh from the server at once | Nothing to unset — the screen is the control. Its mutations need a board actor; the mode switch stays locked while `MYRMIDON_BUDGET_LIMITS_SIGNAL_ONLY` forces the value |


## settings-ru-new

<!-- after: 1.7 — BUDGET-CONFIG B: режим исполнения лимитов расхода -->
### 1.7 — BUDGET-CONFIG D: экран «Бюджеты» и лимиты, которые он правит

Экран «Настройки компании → Бюджеты» (`/company/settings/budgets`, гайд
[guides/budget-limits-ui.ru.md](guides/budget-limits-ui.ru.md)) — это место,
где владелец задаёт и меняет лимиты расхода по уровням, видит расход
относительно лимита, включает и выключает глобальный режим «только сигнал» и
читает журнал изменений. Своей переменной окружения у него **нет**: всё, что
он записывает, — живые настройки, экран меняет их в работающем API без
перезапуска и без перезагрузки страницы. Единственная переменная окружения в
этой связке — принудительное переопределение значения «только сигнал», её
называет часть A ([guides/budget-limits.ru.md](guides/budget-limits.ru.md));
экран показывает источник действующего значения и блокирует переключатель,
пока значение задаёт окружение.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| — (переменной нет) | 1.7-BUDGET-CONFIG-D | — | Лимиты по уровням (сумма, период, жёсткий/мягкий) лежат в таблице `budget_limits`, глобальный флаг «только сигнал» — в `instance_settings.general.budgetLimits` (и то и другое — часть A, OPE-4161). Экран правит их на месте: сохранённая строка, её расход и запись журнала обновляются с сервера сразу | Снимать нечего — управление и есть экран. Мутации требуют актора доски; переключатель режима остаётся заблокированным, пока значение задаёт `MYRMIDON_BUDGET_LIMITS_SIGNAL_ONLY` |


## divergence-new

<!-- after: 1.7 — BUDGET-CONFIG B: исполнение лимитов — сигнал / мягкий / жёсткий -->
### 1.7 — BUDGET-CONFIG D: экран «Бюджеты» — дерево уровней, режимы, расход, журнал

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| BUD2-D | Экран владельца для лимитов расхода по уровням: дерево (гнездо — компания и проекты → каста → фуражировка → задача) с суммой, периодом, режимом и расходом против лимита, правка на месте (сохранить/создать/удалить), переключатель глобального режима «только сигнал» с показом источника значения (умолчание / сохранено / переменная окружения — при переменной переключатель заблокирован) и журнал изменений (кто/когда/что, «было → стало»). Экран презентационный: `BudgetLimitsScreenView` только рисует и отдаёт действия наружу, `BudgetLimitsScreen` (контейнер) держит запросы react-query и мутации, `budgetLimitsApi` говорит с контрактом части A (OPE-4161), `budgetLimitsConfig` — чистые помощники (дерево, разбор суммы и ref, ключи подписей). Все видимые строки идут через форк-каталог переводов | `ui/src/App.tsx` (маршрут `company/settings/budgets` с меткой), `ui/src/components/access/CompanySettingsNav.tsx` (пункт «Budgets», определение активного раздела и ключ подписи), `ui/src/components/access/CompanySettingsNav.test.tsx` (два ожидаемых списка разделов и проверка резолва пути дополнены одной строкой каждый — тест держит точный состав навигации) + наши файлы `ui/src/components/myrmidon/budget-limits/{budgetLimitsApi,budgetLimitsConfig,BudgetLimitsScreen,BudgetLimitsScreenContainer}.ts(x)`, `ui/src/i18n/myrmidon-locales/{en,ru}.json` (ключи `budgetLimits.*`, `settingsNav.budgets`), `ui/src/i18n/legacy-screens-no-english.myrmidon.test.ts` (экран добавлен в статический скан) | OPE-4164 (1.7 BUDGET-CONFIG D): цель — владелец задаёт и меняет лимиты в интерфейсе и видит расход относительно лимита на каждом уровне; лимиты должны меняться без перезапуска, а глобальный режим «только сигнал» — показывать, откуда взято его значение | `ui/src/components/myrmidon/budget-limits/budgetLimitsConfig.myrmidon.test.ts` (дерево: компания первой, строки проектов, лимит проекта вне справочника не пропадает, расход и признак превышения, сохранённая строка без расхода = 0, единственная строка фуражировки, сортировка каст и задач, добавленный на экране ref без лимита, отсутствие дублей, порядок обхода; разбор суммы и ref по правилам API), `…/BudgetLimitsScreen.myrmidon.test.tsx` (строки с расходом и пометкой превышения, правка на месте → `onSaveLimit(level, ref, body)`, отказ на неверной сумме без отправки, удаление только у сохранённой строки, добавление касты с отказом на неверном ключе, переключатель «только сигнал» с источником и блокировкой при переменной окружения, журнал и пустой журнал, состояние загрузки), `…/BudgetLimitsScreenContainer.myrmidon.test.tsx` (четыре чтения на выбранную компанию, PUT изменённого лимита с перезапросом дерева/расхода/журнала, PATCH режима, DELETE, ошибки чтения и записи, отсутствие компании — запросов нет), существующий `ui/src/components/access/CompanySettingsNav.test.tsx` (зелёный с новой строкой), `ui/src/i18n/myrmidon-i18n.test.tsx` (паритет ключей en↔ru и запрет нетронутой латиницы в RU) | Никогда, наше поведение. Снятие пункта навигации — вернуть два ожидаемых списка в `CompanySettingsNav.test.tsx` к составу вендора; сам экран снимается удалением `budget-limits/`, ключей `budgetLimits.*` и строки в скане `legacy-screens-no-english.myrmidon.test.ts`. Когда часть A (OPE-4161) сольётся с `@paperclipai/shared`, типы контракта переезжают в общий пакет — в `budgetLimitsApi.ts` остаются только вызовы | (этот PR) |

