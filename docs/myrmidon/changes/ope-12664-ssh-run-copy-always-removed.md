## changelog-en

### The SSH run copy is removed at every end of the run, not only after a successful restore (OPE-12664)

- A synced run in an SSH environment copies the workspace to `<remote workspace>/.paperclip-runtime/runs/<runId>/workspace`, up to 3 GB on the Myrmidon monorepo. The board removed the copy only after a successful restore, so a failed, timed-out or cancelled run left it until the next run on that runner pruned copies older than four hours. On 11.11 and 12.11 that filled the bots disk to 100% and crashed the bots.
- Now the run's whole directory is removed after the restore attempt whatever the outcome of the run. It is also removed when the restore itself fails (the restore error is still reported) and when the workspace upload or the asset staging fails before the run starts. Only this run's directory is touched; an in-place workspace has no run directory, so nothing is removed. A failed removal is logged and does not fail the run. The removal first stops the API bridge server of the run, which stops in parallel with the restore.
- A run whose restore failed no longer keeps its remote copy for recovery: it is removed together with the rest. The four-hour prune at the start of the next run stays as a safety net for runs that never reach their end, for example when the board restarts.

## changelog-ru

### Копия прогона в SSH-окружении удаляется при любом завершении, а не только после успешного возврата (OPE-12664)

- Прогон с синхронизацией в SSH-окружении копирует рабочую папку в `<удалённая рабочая папка>/.paperclip-runtime/runs/<runId>/workspace`, на монорепозитории Myrmidon до 3 ГБ. Доска удаляла копию только после успешного возврата, поэтому упавший, оборванный по времени или отменённый прогон оставлял её, пока следующий прогон на этом исполнителе не удалит копии старше четырёх часов. 11.11 и 12.11 это заполнило диск ботов до 100% и уронило ботов.
- Теперь каталог прогона целиком удаляется после попытки возврата при любом исходе прогона. Он удаляется и когда сам возврат не удался (ошибка возврата по-прежнему сообщается), и когда не удалась загрузка рабочей папки или подготовка ресурсов до старта прогона. Затрагивается только каталог этого прогона; у рабочей папки без копирования каталога прогона нет, и ничего не удаляется. Неудавшееся удаление пишется в журнал и прогон не роняет. Перед удалением останавливается сервер моста к API этого прогона: он останавливается параллельно с возвратом.
- Прогон с неудавшимся возвратом больше не хранит удалённую копию для восстановления: она удаляется вместе с остальным. Удаление старше четырёх часов при старте следующего прогона остаётся страховкой для прогонов, которые не дошли до конца, например при перезапуске доски.
