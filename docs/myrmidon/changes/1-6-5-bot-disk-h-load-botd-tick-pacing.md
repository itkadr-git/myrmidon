## changelog-en

### botd paces its tick by the board's nextReportSec; errors back off exponentially (1.6.5 BOT-DISK-H LOAD)

- The fleet hammered the board with ~189 disk reports per five minutes instead
  of ~72: the loop paused on `min(intervalMs, nextReportSec)`, so the default
  60 s interval clamped the board's 300 s cadence and every tick re-polled
  desired-state. The pause after a successful pass is now the board's
  `nextReportSec` (floored 10 s, capped 1 h) stretched by one-sided 0..+10 %
  jitter — never shorter, so "not more often than once per nextReportSec"
  holds for both the disk report and the desired-state poll. `intervalMs` is
  only the initial value until the first accepted report.
- A failed pass (report rejected or desired-state poll failed) no longer keeps
  the flat cadence: the wait grows exponentially, `intervalMs * 2^k` over the
  consecutive failed passes, floor 10 s, cap 1 h, ±10 % jitter so the fleet
  does not resynchronise; the first success resets the streak and returns to
  the board's cadence.
- SIGUSR1 (a run woke the bot) stays an immediate trigger: it cancels the
  pending pause and is not bound by the pacing; the desired poll inside a pass
  remains single-flight.
- The desired-state client's own `start()` timer default moved from 60 s to
  300 s. botd never runs it — the entry wires `poll()` through the main loop
  only — but an autonomous `start()` can no longer add a parallel 60 s poll.

## changelog-ru

### botd тикит по board's nextReportSec; при ошибках — экспоненциальная пауза (1.6.5 BOT-DISK-H LOAD)

- Флот слал ~189 disk-отчётов за 5 минут вместо ~72: цикл ждал `min(intervalMs,
  nextReportSec)`, дефолтные 60 с зажимали бордовые 300 с, и desired-state
  опрашивался на каждом тике. Пауза после успешного прогона теперь
  `nextReportSec` борды (пол 10 с, потолок 1 ч), растянутая односторонним
  джиттером 0..+10 % — никогда короче, поэтому «не чаще одного nextReportSec»
  держится и для disk-report, и для опроса desired-state. `intervalMs` остаётся
  только начальным значением до первого принятого отчёта.
- Провальный прогон (отчёт не принят или опрос desired-state не удался) больше
  не ждёт ровно интервал: пауза растёт экспоненциально, `intervalMs * 2^k` по
  числу подряд неудачных прогонов, пол 10 с, потолок 1 ч, ±10 % джиттера, чтобы
  флот не синхронизировался; первый успех сбрасывает серию и возвращает бордовый
  темп.
- SIGUSR1 (пробуждение прогоном) остаётся мгновенным триггером: снимает
  ожидающую паузу и не связан ограничением тика; опрос desired внутри прогона
  по-прежнему single-flight.
- Дефолт таймера `start()` клиента desired-state перенесён с 60 с на 300 с.
  botd его не запускает — точка входа подключает только `poll()` через главный
  цикл, — но автономный `start()` больше не создаёт параллельный опрос каждые
  60 с.
