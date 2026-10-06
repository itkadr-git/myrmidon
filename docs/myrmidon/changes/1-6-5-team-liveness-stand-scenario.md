## changelog-en

### Team liveness: the stand scenario that lets the watchdog be switched off (TEAM-LIVENESS-STAND)

`scripts/myrmidon/team-liveness/stand-recovery.ts` rehearses the situation the
whole epic exists for: the gateway dies mid-run, and the team comes back by
itself. It carries no liveness logic of its own — every decision is taken by the
product passes (RUN-STALL by progress, AUTO-RESUME, IDLE-PICKUP) built exactly as
the server builds them; the runner seeds the situation, SIGKILLs the process,
steps the clock and reads the database back.

The verdict names three legs: the run is settled, the task is not left waiting
(it left `in_progress` and has a wake or a live run), the agent is not stuck in
`error` — all inside a budget (10 minutes by default), and the exit code carries
the result. `rehearse` is self-contained (throwaway embedded database, a real
gateway process) and writes the knobs through the instance settings API, so it
also shows a saved value taking effect without a restart. `watch` is read-only
against the live board database, for the real kill on the stand.

Runbook: [guides/team-liveness-stand-scenario.md](../guides/team-liveness-stand-scenario.md).

Note on the budget: the default stall threshold (20 min) is longer than the
10-minute budget, so a silent run is only noticed later. The rehearsal sets the
threshold below the budget through the settings area; a kill that takes the run
terminal immediately does not involve the threshold at all.

## changelog-ru

### Команда жива: стенд-сценарий, после которого сторож можно выключать (TEAM-LIVENESS-STAND)

`scripts/myrmidon/team-liveness/stand-recovery.ts` разыгрывает ту самую
ситуацию, ради которой затевался весь эпик: шлюз умирает посреди прогона, а
команда поднимается сама. Своей логики живости у запускалки нет — все решения
принимают боевые проходы (RUN-STALL по прогрессу, AUTO-RESUME, IDLE-PICKUP),
собранные так же, как их собирает сервер; запускалка создаёт ситуацию, убивает
процесс SIGKILL'ом, двигает часы и читает базу обратно.

Вердикт называет три ноги: прогон доведён до терминала, задача не брошена (вышла
из `in_progress` и на неё есть побудка или живой прогон), агент не застрял в
`error` — и всё это внутри бюджета (по умолчанию 10 минут); код возврата несёт
результат. `rehearse` самодостаточен (одноразовая embedded-база, настоящий
процесс шлюза) и пишет настройки через API инстанса, поэтому заодно показывает,
что сохранённое значение действует без перезапуска. `watch` — только чтение
боевой базы доски, для настоящего убийства на стенде.

Инструкция: [guides/team-liveness-stand-scenario.ru.md](../guides/team-liveness-stand-scenario.ru.md).

Про бюджет: порог застоя по умолчанию (20 мин) длиннее бюджета в 10 минут,
поэтому тихий прогон доска заметит позже. Генеральная репетиция ставит порог ниже
бюджета через область настроек; если убийство шлюза уводит прогон в терминал
сразу, порог вообще ни при чём.