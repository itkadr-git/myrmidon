---
settings-section: Track 5 — operations
---

## changelog-en

### TASK-CARD-READINESS-4: Task card edit target existence verification on main

- Extends task card readiness verification (`assertTaskCardReadyWithEditTargets`, `verifyEditTargets`, `extractEditTargetPaths`) to verify repository file paths specified in «МЕСТО ПРАВКИ».
- Probes paths against the default branch via GitHub raw content; absent files yield `EDIT_TARGET_NOT_FOUND` (422 in enforce mode).
- Paths marked as new files («новый файл», «new file») are excluded from probing.
- Network errors or missing GitHub connections fail open with `EDIT_TARGET_UNVERIFIED` warnings without blocking transitions.

## changelog-ru

### TASK-CARD-READINESS-4: Проверка существования места правки карточки задачи на main

- Расширение проверки готовности карточек задач (`assertTaskCardReadyWithEditTargets`, `verifyEditTargets`, `extractEditTargetPaths`) для валидации путей к файлам репозитория из раздела «МЕСТО ПРАВКИ».
- Проверяет существование файлов на ветке по умолчанию через raw content GitHub; отсутствующий файл возвращает `EDIT_TARGET_NOT_FOUND` (422 в режиме enforce).
- Пути с пометкой о новом файле («новый файл», «new file») исключаются из проверки и не блокируют переход.
- Сетевые ошибки и отсутствие подключения к GitHub обрабатываются fail-open с предупреждением `EDIT_TARGET_UNVERIFIED` без блокировки перехода.
