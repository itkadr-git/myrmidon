## changelog-en

### SSH environments no longer fill the remote disk; omp model ids save on the card (OPE-12633)

- A synced run in an SSH environment copies the workspace to `<remote workspace>/.paperclip-runtime/runs/<runId>/workspace`; on the Myrmidon monorepo that is about 0.8 GB per run, and nothing removed it. After a successful restore, the run's workspace copy is now removed. The small runtime directory stays: the API bridge stops in parallel. Run directories older than two days are pruned when the next run starts. A failed restore keeps the copy, so the run's work is not lost.
- The agent card accepts an omp model id in the form omp runs it: one of the agent's custom provider keys (`MYRMIDON_OMP_PROVIDERS`) followed by a gateway model from the list, e.g. `litellm/antigravity/gemini-3.8-flash-medium`. Before, the board refused that id and the card could only be repaired in the database.

## changelog-ru

### SSH-окружения больше не забивают диск исполнителя; идентификатор модели omp сохраняется в карточке (OPE-12633)

- Прогон с синхронизацией в SSH-окружении копирует рабочую копию в `<удалённая рабочая папка>/.paperclip-runtime/runs/<runId>/workspace`. Для монорепозитория Myrmidon это около 0,8 ГБ на прогон, и копию никто не удалял. Теперь:
  - после успешного возврата копия прогона удаляется;
  - небольшой служебный каталог остаётся, потому что мост к API останавливается параллельно;
  - каталоги прогонов старше двух суток удаляются при старте следующего прогона;
  - при неудачном возврате копия сохраняется, чтобы работа прогона не потерялась.
- Карточка агента принимает идентификатор модели omp в том виде, в каком его запускает omp. Это ключ пользовательского провайдера агента (`MYRMIDON_OMP_PROVIDERS`) и модель шлюза из списка, например `litellm/antigravity/gemini-3.8-flash-medium`. Раньше доска отклоняла такой идентификатор, и карточку можно было исправить только в базе.
