## changelog-en

### Starter pack delivered first in the assignee wake (1.6.9 STARTER-PACK-V1)

- If a task has a document with the key `starter-pack`, its text is now delivered to the assignee as a separate block, `Starter pack (start here; do not re-explore the project):`, at the start of the wake prompt, ahead of the continuation summary and the task blocks.
- The block body is capped at 8000 characters; a longer body is cut and ends with `[starter pack truncated]`. The document passes the same source-trust redaction as the continuation summary.
- An isolated reviewer run does not get the block. A task without the document gets the same wake prompt as before.

## changelog-ru

### Стартовый пакет первым блоком в побудке исполнителя (1.6.9 STARTER-PACK-V1)

- Если у задачи есть документ с ключом `starter-pack`, его текст теперь идёт исполнителю отдельным блоком `Starter pack (start here; do not re-explore the project):` в начале текста побудки, раньше сводки продолжения и остальных блоков задачи.
- Тело блока не длиннее 8000 знаков; более длинное обрезается и заканчивается строкой `[starter pack truncated]`. Документ проходит ту же редакцию по доверию источника, что и сводка продолжения.
- Изолированный прогон ревьюера блок не получает. У задачи без документа побудка прежняя.
