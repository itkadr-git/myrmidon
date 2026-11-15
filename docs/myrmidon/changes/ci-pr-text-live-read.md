## changelog-en

### CI: the PR text checks read the current title and description on re-run

- The `checks` job steps "PR text - publish scan" and "PR text - AI signatures" now read the PR title and body through the API when they run. A re-run after a description edit checks the new text.
- If the API call fails, the steps scan the text from the triggering event, so the check is not weakened.

## changelog-ru

### CI: проверки текста PR читают актуальные заголовок и описание при перезапуске

- Шаги «PR text - publish scan» и «PR text - AI signatures» job `checks` теперь читают заголовок и тело PR через API в момент выполнения. Перезапуск после правки описания проверяет новый текст.
- Если запрос к API не удался, шаги сканируют текст события, запустившего прогон, поэтому проверка не ослабляется.
