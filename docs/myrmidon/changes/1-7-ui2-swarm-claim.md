## changelog-en

### 1.7 UI2 — swarm-claim settings in Runs & queue (OPE-10133)

The UI 2.0 Settings → Runs & queue screen now includes the swarm-claim
controls: the master switch, task lease TTL, and per-agent task limit. Each
control shows whether its effective value comes from saved settings, an
environment override, or the built-in default; environment-pinned values are
disabled. Queue counters remain live, and saves apply immediately without a
restart. The legacy pheromone display, cooldown window, and change log remain
in the existing panel.

How to check: with `enableMyrmidonUi2` enabled, open
`/company/settings/runs-queue`; configure and save the three controls, verify
source badges and live queue counters, and confirm environment-pinned controls
are disabled. See `Ui2SwarmClaimBlock.myrmidon.test.tsx` for mocked API tests.

## changelog-ru

### 1.7 UI2 — настройки swarm-claim в разделе «Прогоны и очередь» (OPE-10133)

На экране «Настройки → Прогоны и очередь» в UI 2.0 появился блок управления
swarm-claim: главный переключатель, TTL аренды задачи и лимит задач на агента.
Для каждого поля показывается источник действующего значения: сохранённая
настройка, переопределение окружением или встроенное значение по умолчанию;
поля, закреплённые переменными окружения, недоступны для редактирования.
Счётчики очереди отображаются в реальном времени, изменения применяются без
перезапуска. Феромонное отображение, окно остывания и журнал изменений остаются
в прежней панели.

Как проверить: при включённом `enableMyrmidonUi2` откройте
`/company/settings/runs-queue`; измените и сохраните три параметра, проверьте
метки источников, живые счётчики очереди и блокировку полей, заданных
окружением. API-компонента замокан в тестах
`Ui2SwarmClaimBlock.myrmidon.test.tsx`.
