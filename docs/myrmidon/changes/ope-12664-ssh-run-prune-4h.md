## changelog-en

### SSH run copies of failed and cancelled runs are pruned after four hours (OPE-12664)

- A failed or cancelled run in an SSH environment never reaches the restore that removes its workspace copy. Run directories older than four hours are now pruned when the next run starts (before: two days). The longest run timeout is three hours. On 11.11 one omp runner held 24 copies of 1.5 GB.

## changelog-ru

### Копии упавших и отменённых прогонов в SSH-окружениях удаляются через четыре часа (OPE-12664)

- Упавший или отменённый прогон в SSH-окружении не доходит до возврата, который удаляет его копию рабочей папки. Теперь каталоги прогонов старше четырёх часов удаляются при старте следующего прогона (было — двое суток). Самый длинный прогон — три часа. 11.11 у одного исполнителя omp скопилось 24 копии по 1,5 ГБ.
