## changelog-en

### Cancelling an omp_local SSH run no longer depends on the board reaching the process first (1.6.8 OMP-RUN-GUARD-2)

- On 13.11.2026 two omp sessions kept running on the runner after their run was cancelled because of a task reassignment: 46 and 22 minutes, 337 model calls, 28.6M input tokens. OPE-12801 (#2980) made the SSH lane stop the runner's processes once the local ssh client ends on a signal; that part is a prerequisite and is unchanged.
- What was still missing: the board stops the local ssh client only if the client is registered in `runningProcesses` at the moment of the cancellation. A cancellation that came while the client was being started found nothing to stop, and the adapter looked at the aborted signal only after the process ended on its own (up to `timeoutSec`, 3 hours).
- The `omp_local` adapter now listens to the run's cancellation signal while OMP runs (SSH runs, which opt into signal cancellation) and signals the local client itself (SIGTERM, SIGKILL after `graceSec`); an abort that came before the client was registered is applied when it starts. The client ending on a signal makes the target stop OMP and its tools on the runner, as before.

## changelog-ru

### Отмена SSH-прогона omp_local больше не зависит от того, успеет ли доска к процессу (1.6.8 OMP-RUN-GUARD-2)

- 13.11.2026 два сеанса omp продолжали идти на раннере после отмены прогона из-за переназначения задачи: 46 и 22 минуты, 337 вызовов модели, 28,6 млн входных токенов. OPE-12801 (#2980) научил SSH-канал останавливать процессы на раннере, когда локальный клиент ssh завершился по сигналу; эта часть - предпосылка и не менялась.
- Чего не хватало: доска останавливает локальный клиент ssh, только если он записан в `runningProcesses` в момент отмены. Отмена, пришедшая в момент запуска клиента, не находила, что останавливать, а адаптер смотрел на прерванный сигнал лишь после того, как процесс завершался сам (до `timeoutSec`, 3 часа).
- Адаптер `omp_local` теперь слушает сигнал отмены прогона, пока работает OMP (SSH-прогоны, которые подписаны на отмену по сигналу), и сам сигналит локальному клиенту (SIGTERM, SIGKILL через `graceSec`); отмена, пришедшая до регистрации клиента, применяется при его запуске. Завершение клиента по сигналу, как и раньше, заставляет канал остановить OMP и его инструменты на раннере.
