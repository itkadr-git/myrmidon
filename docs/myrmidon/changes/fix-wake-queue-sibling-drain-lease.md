## changelog-en

### Release drain no longer leaves sibling issues locked or blocked (1.6.6)

- A sibling issue released by a finished run now keeps the execution lease only while it has a deferred wake to drain; otherwise the lease is handed back and the primary issue is drained as before.
- A release gated on a blocked primary issue reports the block again instead of reporting the sibling as released.

## changelog-ru

### Release-drain больше не оставляет соседние задачи с замком или в blocked (1.6.6)

- Соседняя задача, освобождённая завершившимся run, удерживает замок исполнения только пока у неё есть отложенная побудка; иначе замок возвращается, а основная задача сливается как раньше.
- Освобождение при заблокированной основной задаче снова сообщает о блокировке, а не о «освобождённой» соседней.
