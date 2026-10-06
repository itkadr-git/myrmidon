---
divergence-section: Трек 5 — эксплуатация
---

## changelog-en

### Review-return loop: a work product without a repo no longer fails the pass (REVIEW-REWORK)

- A `pull_request` work product whose metadata has no `repo` (an older record
  that carries only a number or a URL) used to crash the sweep with
  `TypeError: Cannot read properties of undefined (reading 'toLowerCase')`
  while the PR coordinates were being collected, so the whole task failed
  every pass. Now the loop reads the repo from the work product's
  pull-request URL when the metadata has none, and silently skips the entry
  when neither the metadata nor the URL yields coordinates — one bad record
  never fails the task's pass again.

## changelog-ru

### Цикл возврата ревью: work product без поля repo больше не роняет проход (REVIEW-REWORK)

- Work product типа `pull_request` без `repo` в метаданных (старая запись,
  где есть только номер или URL) ронял наблюдателя с
  `TypeError: Cannot read properties of undefined (reading 'toLowerCase')`
  на сборе координат PR — задача падала каждый проход. Теперь цикл берёт
  репозиторий из URL пул-реквеста, когда в метаданных его нет, а запись без
  читаемых координат молча пропускает: одна битая запись больше не срывает
  обработку задачи.

## divergence

| REVIEW-REWORK | Чтение work product `pull_request` без `repo` в метаданных: repo восстанавливается из URL пул-реквеста, запись без координат пропускается; фильтр store отбрасывает записи без repo/number (spread `null` больше не проскакивает в sweep) | — (оба файла fork-owned: `server/src/myrmidon/review-rework/sweep.ts`, `server/src/myrmidon/review-rework/store.ts`) | Записи без `repo` роняли `extractPrCoordinates` (`toLowerCase of undefined`), проход задачи падал целиком | `server/src/myrmidon/review-rework/sweep.myrmidon.test.ts` (запись без repo пропускается; repo из URL; проход с битой записью завершается) | Никогда — наше поведение. Снятие: вернуть прежний фильтр в `store.ts` и цикл `known` в `sweep.ts` | (этот PR) |
