---
divergence-section: Трек 1 — платформа
---

## changelog-en

### Standalone worker entry (`pnpm --filter @myrmidon/server worker`)

- A dedicated launch point for the `worker` process role: `node dist/worker.js` boots the
  same board runtime as `index.ts` with `MYRMIDON_PROCESS_ROLE=worker` (set by the entry when
  unset, kept when already `worker`, refused for any other role). The role profile, the
  supervisor, the process registry and the `/internal/ready` + `/healthz` routes are the
  ones already shipped; the entry adds none of them a second time.
- The default launch (`node dist/index.js`, one process) is unchanged.

## changelog-ru

### Отдельная точка входа worker (`pnpm --filter @myrmidon/server worker`)

- Выделенный запуск роли процесса `worker`: `node dist/worker.js` поднимает тот же рантайм
  доски, что и `index.ts`, с ролью `MYRMIDON_PROCESS_ROLE=worker` (если роль не задана —
  выставляет сам, если уже `worker` — оставляет, любую другую роль отвергает). Профиль роли,
  супервизор, реестр процессов и маршруты `/internal/ready` и `/healthz` — уже
  существующие; точка входа их не дублирует.
- Запуск по умолчанию (`node dist/index.js`, один процесс) не меняется.
