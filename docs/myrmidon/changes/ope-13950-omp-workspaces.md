## changelog-en

### OMP SSH task workspaces

OMP SSH runners include `myr-ws` and Node 24. For task runs without an explicit `workspaceSync` setting, the adapter no longer copies the board checkout to the runner: it supplies `MYRMIDON_TASK_FOLDER_NAME`, `MYRMIDON_TASK_BRANCH`, and a persistent runner-local `MYRMIDON_WS_HOME`, and instructs the agent to open the task repository with `myr-ws open`. Explicit workspace sync settings retain their existing behaviour. Non-task and non-SSH runs are unchanged.

Deploy the signed CI-built runner image through the normal operator procedure. After deployment, verify a new eng-10 task checkout's size and branch on the runner; existing full clones are not removed by this change. `myr-ws` uses `/cache/git` as a read-only object mirror when available and stores its registry and writable bare bases in `/home/paperclip/.myrmidon`.

## changelog-ru

### Рабочие копии задач OMP SSH

Раннеры OMP SSH содержат `myr-ws` и Node 24. Для запусков задач без явно заданного `workspaceSync` адаптер больше не копирует рабочую копию доски на раннер: он передаёт `MYRMIDON_TASK_FOLDER_NAME`, `MYRMIDON_TASK_BRANCH` и постоянный локальный `MYRMIDON_WS_HOME` и предлагает агенту открыть репозиторий задачи через `myr-ws open`. Явные настройки синхронизации, запуски не по задаче и запуски не через SSH не меняются.

Оператор разворачивает подписанный образ раннера, собранный CI, обычным способом. После выката нужно проверить размер и ветку новой копии задачи eng-10; существующие полные копии не удаляются. При наличии `/cache/git` утилита `myr-ws` использует его как зеркало объектов только для чтения, а реестр и записываемые bare-базы хранит в `/home/paperclip/.myrmidon`.
