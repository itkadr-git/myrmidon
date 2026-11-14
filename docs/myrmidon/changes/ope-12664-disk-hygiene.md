## changelog-en

### Deploys remove unused release images after success (OPE-12664)

- A successful product deploy now removes unused `myrmidon*` and `agent-runtime*` images from the deploy host. Docker containers in any state keep their image. The sweep does not run when the deploy fails, and a cleanup failure is logged without changing the successful deploy result.
- The deploy host disk signal measures both the root filesystem and `/srv/myrmidon-xfs`. It warns above 85% and raises a critical signal above 90% with the largest consumers. The root and bot-partition checks use the existing host-disk attention and owner-notification path.

## changelog-ru

### После успешного выката удаляются неиспользуемые образы (OPE-12664)

- Успешный продуктовый выкат теперь удаляет на хосте образы `myrmidon*` и `agent-runtime*`, которыми не пользуется ни один контейнер. Образы контейнеров в любом состоянии сохраняются. При неуспешном выкате очистка не запускается, а ошибка очистки только записывается в журнал и не меняет результат успешного выката.
- Сторож диска измеряет корневую файловую систему и `/srv/myrmidon-xfs`. При заполнении выше 85% он выдаёт предупреждение, а выше 90% — критический сигнал с крупнейшими потребителями. Для корня и раздела ботов используется существующий поток внимания и уведомления владельцу.
