## changelog-en

### fleetd: a fleet site pulls a release image it does not have yet (1.6.6 OPE-12194)

The bot image rollout pre-pulls release images only on the hosts it reaches by ssh (`MYRMIDON_BOT_IMAGE_ROLLOUT_FLEET_HOSTS`). A fleet site registered on the board got its first container of a new release image refused with Docker 404 «No such image», and its bot never switched (prod 07.11: work-qa on myr-vm1). On that 404, fleetd now pulls the allowlisted image (no registry auth: the release bot images are public) and retries the create. The pull is detached from the board request, so a board call that gives up waiting does not abort it, and a failed pull is reported in the create error.

## changelog-ru

### fleetd: площадка флота сама скачивает образ выпуска, которого у неё ещё нет (1.6.6 OPE-12194)

Раскатка образов ботов заранее скачивает образы выпуска только на хосты, до которых доходит по ssh (`MYRMIDON_BOT_IMAGE_ROLLOUT_FLEET_HOSTS`). Площадка флота, зарегистрированная в доске, получала на первый контейнер нового образа отказ Docker 404 «No such image», и её бот не переходил на выпуск (бой 07.11: work-qa на myr-vm1). Теперь при таком 404 fleetd скачивает образ из разрешённого списка (без ключа реестра: образы ботов выпуска публичные) и повторяет создание. Скачивание не зависит от запроса доски: если доска перестала ждать, оно не обрывается. Ошибка скачивания попадает в ошибку создания.
