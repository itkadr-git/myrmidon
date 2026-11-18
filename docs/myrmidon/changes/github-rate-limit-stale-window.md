## changelog-en

### A GitHub rate-limit answer after the window reset pauses the board for one minute, not an hour

When GitHub answered 403/429 as a primary rate limit and the known rate-limit
window was already over (the answer crossed the window edge, or the headers
were stale), the API process locked itself for one hour. A locked process makes
no request, gets no fresh headers, and never learns that the limit is back.
On 16.11 one board process stayed locked from 06:14 to 07:28 UTC while another
had 4387 of 5000 requests left. The board did not merge PRs, and reviewers did
not see CI. Now such an answer pauses GitHub reads for 60 seconds. The one-hour
pause stays only when the window is not known at all. The retry-after header and a
window in the future behave as before.

## changelog-ru

### Ответ GitHub об ограничении после сброса окна ставит доску на паузу в минуту, а не в час

Если GitHub отвечал 403/429 как первичный лимит, а известное окно лимита уже
прошло (ответ пришёл на границе окна или по устаревшим заголовкам), процесс
API запирал себя на час. Запертый процесс не делает запросов, не получает
свежих заголовков и не узнаёт, что лимит восстановлен. 16.11 один процесс
доски простоял запертым с 06:14 до 07:28 UTC, пока у другого оставалось 4387
из 5000 запросов: доска не вливала PR, ревьюеры не видели CI. Теперь такой
ответ ставит чтения GitHub на паузу в 60 секунд. Час остаётся только когда
окно неизвестно совсем. Заголовок retry-after и окно в будущем работают как прежде.
