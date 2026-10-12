---
settings-section: Track 5 — operations
---

## settings-en

| `MYRMIDON_BOT_SCOPE_SUBDIR` | BOT-DISK-F | set by the driver, not by the operator | Internal variable the Docker driver passes to a bot container that is a member of a SHARED isolation-scope instance: the name of the member's own subdirectory (its bot key) inside the instance directory mounted at `/bot-scope`. The image entrypoint links `/data/{hermes,workspace,scratch}` into `/bot-scope/<value>/`. Not a secret. Do not set it by hand | Absent — the bot is isolated (single layout, own `/bot` mount). A value that is not a plain directory name (contains `/`, is `.`/`..` or starts with `-`) or whose directory is missing — the entrypoint refuses to start |
| `MYRMIDON_PROCESS_CONTAINER` | PROCS-0.1 | unset — the container id from `HOSTNAME` | Container name recorded for this board process in the process registry (the `container` field of the processes panel). Override for split deployments where the container name is the operator's, not the runtime's (Docker sets `HOSTNAME` to the container id) | Unset or empty — `HOSTNAME`; if that is empty too — no container is recorded. Informational only, no behavior depends on it |

## settings-ru

| `MYRMIDON_BOT_SCOPE_SUBDIR` | BOT-DISK-F | выставляет драйвер, не оператор | Внутренняя переменная: Docker-драйвер передаёт её контейнеру бота, который входит в ОБЩИЙ экземпляр области изоляции, — имя собственного подкаталога участника (его ключ бота) внутри каталога экземпляра, смонтированного в `/bot-scope`. Entrypoint образа линкует `/data/{hermes,workspace,scratch}` в `/bot-scope/<значение>/`. Не секрет. Руками не задавать | Не задана — бот изолирован (одиночная раскладка, свой mount `/bot`). Значение не из одного имени каталога (есть `/`, `.`/`..` или начинается с `-`) или каталога нет — entrypoint отказывается стартовать |
| `MYRMIDON_PROCESS_CONTAINER` | PROCS-0.1 | не задана — id контейнера из `HOSTNAME` | Имя контейнера, которое реестр процессов записывает для этого процесса доски (поле `container` панели процессов). Переопределение для раздельных развёртываний, где имя контейнера выбирает оператор, а не рантайм (Docker кладёт в `HOSTNAME` id контейнера) | Не задана или пуста — `HOSTNAME`; если и он пуст — контейнер не записывается. Только справочно, поведение от неё не зависит |
