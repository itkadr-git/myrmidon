## changelog-en

### OPE-12609: the post-deploy bot smoke no longer reports idle-stopped bots as crashed

- Docker keeps the last Health.Status of a container after it stops, so a bot idle-stopped hours before the deploy still read "unhealthy" and the smoke reported it as `crashed:docker_unhealthy` (rc.20, 10.11: seven bots, deploy exit code 1 on a healthy fleet). The health mark now counts only for a container that is not exited, dead or created; a stopped one is judged by its exit (before the deploy, or an idle-stop 143, is idle).

## changelog-ru

### OPE-12609: проверка ботов после выката больше не считает остановленных по простою упавшими

- Docker хранит последний Health.Status контейнера после остановки, поэтому бот, остановленный по простою за часы до выката, читался как «unhealthy», и проверка записывала его в `crashed:docker_unhealthy` (rc.20, 10.11: семь ботов, код выхода 1 при здоровом флоте). Отметка здоровья теперь учитывается только у контейнера, который не exited, не dead и не created; остановленный судится по выходу (до выката или idle-stop 143 — простой).
