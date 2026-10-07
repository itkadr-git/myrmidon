## changelog-en

### Gateway run reattach is lease-guarded and periodic (T1.6)

- A board process no longer steals gateway runs that belong to a live
  controller. The reattach sweep (startup and the new 30-second periodic
  pass) only claims runs whose legacy controller lease is absent or expired;
  a live lease under another boot id is reported as skipped and left to its
  owner. This removes the "Legacy controller lease lost" abort when a second
  board process starts alongside a running one.
- A graceful hot restart still adopts its predecessor's runs immediately:
  the departing process records its controller boot id in the restart-intent
  shutdown snapshot, and the successor's startup pass marks it adoptable, so
  no run is waited out or duplicated.
- When an executor process dies, its gateway runs are reattached on a live
  process by the periodic pass once the lease expires — before the orphan
  reaper's stale window finalizes them as "Process lost".
- Single-process boards keep the previous behavior: startup reattach runs
  exactly as before, plus the same sweep now also ticks periodically.

## changelog-ru

### Перехват gateway-прогонов стал арендно-защищённым и периодическим (T1.6)

- Процесс доски больше не забирает gateway-прогоны у живого контроллера.
  Pass перехвата (стартовый и новый периодический, раз в 30 с) берёт только
  прогоны с отсутствующей или истёкшей ареной legacy-контроллера; живая
  аренда под чужим boot id помечается как пропущенная и остаётся владельцу.
  Это убирает `Legacy controller lease lost` при старте второго процесса
  доски рядом с работающим.
- Корректный hot-restart по-прежнему сразу забирает прогоны предшественника:
  уходящий процесс пишет свой controller boot id в снимок intent, преемник на
  старте помечает его adoptable — прогоны не теряются и не дублируются.
- Если процесс-исполнитель умер, его gateway-прогоны подхватывает
  периодический pass после истечения аренды — до того, как reaper финализирует
  их как «Process lost».
- Однопроцессная доска ведёт себя как раньше: стартовый перехват работает
  прежним образом, плюс тот же sweep теперь тикает периодически.
