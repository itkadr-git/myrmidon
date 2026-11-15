## changelog-en

### CI: main runs complete instead of cancelling each other

- Every push to main cancelled the running Myrmidon CI run; with merges more frequent than a full run, main had no completed run for hours and `main-green-gate` never turned green. Pushes to main no longer cancel the running main run: the concurrency group keeps one running and one pending run, so runs do not pile up.

## changelog-ru

### CI: прогоны main доходят до конца, а не отменяют друг друга

- Каждый push в main отменял идущий прогон Myrmidon CI; при вливаниях чаще полного прогона main часами оставался без законченного прогона, и `main-green-gate` не зеленел. Push в main больше не отменяет идущий прогон: группа concurrency держит один идущий и один ожидающий прогон, очередь не копится.
