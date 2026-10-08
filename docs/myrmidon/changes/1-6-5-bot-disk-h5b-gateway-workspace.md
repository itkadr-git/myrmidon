---
divergence-section: 1.6.1 — BOT-DISK B: общий кэш пакетов для контейнеров ботов
---

## changelog-en

### A run's `workspace` field opens the task copy before the model starts (1.6.5 BOT-DISK-H5b)

- The bot runtime's gateway patch `10-run-workspace-open.patch` makes `/v1/runs`
  accept an optional `workspace` field (`{"key", "repo", "baseRef"?}`). Before the
  model starts the gateway runs `myr-ws open <key> <repo> [--base <ref>] --json`
  (120 s limit) and starts the run in the opened copy: it becomes the run's
  working directory and `MYRMIDON_TASK_WORKSPACE` for its terminal commands.
- Exit codes 3, 4 and 5 (quota refusal, base limit, network) never fail the run
  silently: it starts in `/scratch` and the run's event stream carries a
  `run.workspace_fallback` warning. Any other failure fails the run loudly.
- A run without the field behaves as before, and its commands never inherit
  another run's workspace path.

## changelog-ru

### Поле `workspace` в запуске открывает копию задачи до старта модели (1.6.5 BOT-DISK-H5b)

- Патч гейтвея среды ботов `10-run-workspace-open.patch`: `/v1/runs` принимает
  необязательное поле `workspace` (`{"key", "repo", "baseRef"?}`). До старта
  модели гейтвей выполняет `myr-ws open <key> <repo> [--base <ref>] --json`
  (лимит 120 с) и запускает прогон в открытой копии: она становится рабочим
  каталогом прогона и `MYRMIDON_TASK_WORKSPACE` для его команд терминала.
- Коды выхода 3, 4 и 5 (отказ по квоте, лимит базы, сеть) не роняют прогон
  молча: он стартует в `/scratch`, а в потоке событий прогона появляется
  предупреждение `run.workspace_fallback`. Любой другой сбой роняет прогон явно.
- Прогон без поля работает как раньше, а его команды никогда не наследуют путь
  рабочей копии другого прогона.

## divergence

| 1.6.5-BOT-DISK-H5b | Патч `10-run-workspace-open.patch` к hermes: поле `workspace` в `/v1/runs`, запуск `myr-ws open` до модели, привязка cwd и `MYRMIDON_TASK_WORKSPACE` на прогон, откат в `/scratch` с событием `run.workspace_fallback` при кодах 3/4/5 | Наши файлы: `docker/bot-runtime/patches/10-run-workspace-open.patch` (правки `gateway/platforms/api_server_runs.py`, `tools/environments/local.py`, новый `tools/run_workspace.py`), `patches/README.md`, `docker/bot-runtime/Dockerfile` (импорт-проверка и запуск теста), `docker/bot-runtime/tests/run_workspace_open.py` | Боты работают в копиях задач (BOT-DISK-H): гейтвей в контейнере бота не наследует cwd и окружение от процесса прогона, поэтому путь копии едет в теле запроса. Требование тикета OPE-5365 (часть H5b), контракт C6 | `tests/run_workspace_open.py` в сборке образа (фейковый `myr-ws`: аргументы, cwd/env на прогон, откат при 3/4/5, жёсткий отказ при прочих кодах, прогон без поля) | Снимается, когда upstream hermes получит равнозначное поле рабочей копии на `/v1/runs` или доске не понадобятся копии на задачу. Снятие: удалить патч, строку README, шаги Dockerfile и тест | (этот PR) |
