# OMP SSH task workspaces (OPE-13950)

OMP SSH runners include `myr-ws` and Node 24. For task runs without an explicit `workspaceSync` setting, the adapter no longer copies the board checkout to the runner: it supplies `MYRMIDON_TASK_FOLDER_NAME`, `MYRMIDON_TASK_BRANCH`, and a persistent runner-local `MYRMIDON_WS_HOME`, and instructs the agent to open the task repository with `myr-ws open`. Explicit workspace sync settings retain their existing behaviour. Non-task and non-SSH runs are unchanged.

Deploy the signed CI-built runner image through the normal operator procedure. After deployment, verify a new eng-10 task checkout's size and branch on the runner; existing full clones are not removed by this change. `myr-ws` uses `/cache/git` as a read-only object mirror when available and stores its registry and writable bare bases in `/home/paperclip/.myrmidon`.
