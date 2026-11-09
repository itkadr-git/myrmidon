## changelog-en

### An approved pull request whose head moved goes back to the implementer instead of waiting forever

The board merge loop only merges the head a review verdict names. When the branch moved after
the approval (a new push, or the base merged in), the loop skipped the pull request silently and
nobody was asked to look again: approved PRs sat open for a day with green CI. Now, when the verdict
names another head, the task goes back to the implementer with a "head moved after approval" note,
the same path as a conflict or a branch behind its base; the implementer resubmits and the reviewer
approves the current head. A verdict that names no head is still skipped.

## changelog-ru

### Одобренный PR со сменившейся головой возвращается исполнителю, а не ждёт вечно

Цикл вливания доски сливает только ту голову, которую назвал вердикт ревьюера. Если ветка сдвинулась
после одобрения (новый push или подтянутый main), цикл молча пропускал PR, и никого не просили посмотреть
снова: одобренные PR с зелёным CI висели открытыми по суткам. Теперь, если вердикт называет другую голову,
задача возвращается исполнителю с пометкой «голова сменилась после одобрения» — тем же путём, что при
конфликте или отставании ветки; исполнитель отправляет на ревью, ревьюер одобряет текущую голову.
Вердикт без указанной головы, как и раньше, пропускается.
