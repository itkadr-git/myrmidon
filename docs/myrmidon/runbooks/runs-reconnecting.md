# Runbook: Прогоны висят в reconnecting (`runs-reconnecting`)

- **Ключ:** `runs-reconnecting`
- **Роль владельца:** `devops`
- **Критерий снятия:** `myrmidon_runs_execution_phase{phase="reconnecting"} = 0` (все живые прогоны в фазе `working` или завершены)
- **Метрики:**
  - `myrmidon_runs_execution_phase{phase="reconnecting"}`
  - `myrmidon_runs_reconnecting_oldest_seconds`
  - `myrmidon_runs_active`

---

## Симптомы

- В задаче восстановления или журнале мониторинга появляется тревога: `[devops] Прогоны висят в reconnecting`.
- В метрике `GET /metrics`:
  - `myrmidon_runs_execution_phase{phase="reconnecting"}` > 0
  - `myrmidon_runs_reconnecting_oldest_seconds` > 300
- Условие тревоги: не менее 3 прогонов в `reconnecting` дольше 5 минут (300 с) **или** более 50% живых прогонов находятся в `reconnecting`.
- В API `GET /api/heartbeat-runs/:id` возвращается `"execution": { "phase": "reconnecting", ... }`.
- Агенты не получают новые задачи, ревьюеры не выносят вердикты, задачи простаивают.

---

## Диагностика

1. **Список зависших прогонов**
   - Откройте описание задачи тревоги на доске — сторож перечисляет затронутые `run ID` и время зависания каждого.
   - Также список можно получить через API:
     ```bash
     curl -sS -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
       "$PAPERCLIP_API_URL/api/heartbeat-runs?status=running"
     ```

2. **Проверка метрик**
   ```bash
   curl -sS "$PAPERCLIP_API_URL/metrics" | grep myrmidon_runs_
   ```
   Обратите внимание на:
   - `myrmidon_runs_execution_phase{role="...",phase="reconnecting"}`
   - `myrmidon_runs_reconnecting_oldest_seconds{role="..."}`

3. **Проверка логов и связи агентов**
   - Запросите последние логи конкретного прогона:
     ```bash
     curl -sS -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
       "$PAPERCLIP_API_URL/api/heartbeat-runs/<RUN_ID>/log?tail=100"
     ```
   - Проверьте доступность шлюза агентов (`hermes_gateway`): не прерываются ли входящие сигналы или heartbeat-запросы.
   - Проверьте состояние процессов и воркеров на хостах выполнения.

---

## Устранение

1. **Сетевой сбой / зависший шлюз**
   - Если агенты живы, но сигналы не доходят до доски — восстановите сетевой маршрут к шлюзу или перезапустите сервис шлюза.
   - После восстановления связи агенты отправят очередной пульс, и проекция прогонов автоматически перейдёт в `working`.

2. **Зависший или аварийно завершившийся процесс агента**
   - Если процесс воркера был убит (OOM, сбой хоста) без финализации прогона на доске — отмените зависший прогон:
     ```bash
     curl -sS -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
       "$PAPERCLIP_API_URL/api/heartbeat-runs/<RUN_ID>/cancel"
     ```
   - Задача вернётся в очередь или будет перезапущена согласно политике выполнения.

3. **Массовый сбой проекции**
   - Если сигналы поступают, но фаза ошибочно рассчитывается как `reconnecting` — проверьте логи сервера доски на предмет ошибок в `executionProjectionsForRuns` или координаторе выполнения.

---

## Проверка снятия тревоги

1. Проверьте метрику:
   ```bash
   curl -sS "$PAPERCLIP_API_URL/metrics" | grep myrmidon_runs_execution_phase
   ```
   Значение `phase="reconnecting"` должно быть `0`.
2. Задача восстановления переходит в статус завершения (или снимается сторожем), в журнал мониторинга отправляется событие `status="resolved"`.
