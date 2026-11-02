## changelog-en

### Corpus shadow search follows RAGFlow dataset ids (1.6.6 CORPUS, part A)

- The shadow hook now reads the `dataset_ids` argument of the live RAGFlow
  retrieval tool (an array of RAGFlow dataset ids; the first one is used), so
  `corpus_shadow_log.dataset` is no longer empty for those calls.
- The module leg finds the dataset by its id, by its exact name, or by a
  RAGFlow dataset id: the RAGFlow importer names datasets
  `RAGFlow: <name> [<id>]`, and a name that ends with `[<id>]` matches. A
  missing or ambiguous dataset is still recorded in `module_error`, and the
  search stays inside the company of the bot.

## changelog-ru

### Теневой поиск корпуса понимает id датасетов RAGFlow (1.6.6 CORPUS, часть A)

- Теневой хук читает аргумент `dataset_ids` боевого инструмента поиска RAGFlow
  (массив id датасетов RAGFlow; берётся первый), поэтому
  `corpus_shadow_log.dataset` больше не пуст для таких вызовов.
- Модульная ветка находит датасет по его id, по точному имени или по id
  датасета RAGFlow: импортёр RAGFlow называет датасеты `RAGFlow: <имя> [<id>]`,
  и имя, оканчивающееся на `[<id>]`, подходит. Отсутствующий или неоднозначный
  датасет по-прежнему пишется в `module_error`, а поиск остаётся внутри
  компании бота.
