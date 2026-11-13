## changelog-en

### Gateway slot reconcile ends its pass at the first unreachable probe (OPE-12984)

- When the gateway was down, the `gateway-slot-reconcile` pass probed all of up to 64 finished runs one after another, one timeout per run, and the start of a run waited for all of them (OPE-12964).
- The first `unreachable` answer now ends the pass; `unreachable` is counted once. The memory of runs confirmed closed (OPE-12890) is unchanged, and an unreachable answer is not remembered, so the next pass tries again.

## changelog-ru

### Сверка слотов шлюза завершает проход по первому ответу «недоступен» (OPE-12984)

- Когда шлюз был недоступен, проход `gateway-slot-reconcile` опрашивал подряд все, до 64, завершённые прогоны, по таймауту на каждый, и старт прогона ждал их все (OPE-12964).
- Теперь первый ответ `unreachable` завершает проход; `unreachable` считается один раз. Память подтверждённо закрытых прогонов (OPE-12890) не менялась, а ответ «недоступен» не запоминается, поэтому следующий проход пробует снова.
