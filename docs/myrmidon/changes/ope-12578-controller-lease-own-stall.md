## changelog-en

### OPE-12578: the board keeps its runs after its own event-loop stall

- A run's controller lease was treated as lost as soon as its expiry passed, although no other process had taken it. After a stall of the board process every run it controlled was cancelled ("Legacy controller lease lost": 27 runs on 10.11 03:29Z, ~140 on 09.11).
- Renewal is now decided by the boot id (revocation always replaces it); a passed local deadline first asks the database and aborts only when the renewal is refused, fails, or does not answer within 5 s; a failed background renewal is retried on the next tick.

## changelog-ru

### OPE-12578: доска не отменяет свои прогоны после собственного зависания

- Аренда контроллера прогона считалась потерянной, как только по часам истекал её срок, даже если её никто не забирал. После зависания процесса доски отменялись все его прогоны («Legacy controller lease lost»: 27 прогонов 10.11 в 03:29Z, около 140 за 09.11).
- Продление теперь решает boot id (отзыв всегда ставит новый); истёкший локальный срок сначала спрашивает базу и прерывает прогон, только если продление отказано, упало или не ответило за 5 с; ошибка фонового продления повторяется на следующем тике.
