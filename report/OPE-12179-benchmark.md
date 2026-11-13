# OPE-12179 Ч3 — замер старта было/стало (v3, чистое A/B на одном dist-дереве)

Дата: 2026-11-13. Ветка `bot/OPE-12179-v3`, коммит d6f10bdb9 (ребейз на свежий main).

## Метод
- dist собран esbuild-трансформацией server/src → server/dist (без type-check: полный tsc в контейнере OOM, 4 GiB cgroup).
- Замыкание собрано штатно: `pnpm --filter "@myrmidon/server^..." --filter "!@myrmidon/paperclip-runner" build` + `pnpm --filter @myrmidon/paperclip-runner build:typescript`.
- Прод-разрешение пакетов: `node scripts/myrmidon/prod-runtime-exports.mjs apply --entry @myrmidon/server` + vendor-шимы `server/dist/vendor/paperclip-runner/*.js` переключены на `dist` (правится только в рантайме замера, в коммит не входит).
- Харнесс: `scripts/myrmidon/measure-board-start.mjs --runs 3 --port 3199`, embedded PG, `MYRMIDON_DEPLOYMENT_MODE=local_trusted`, `MYRMIDON_DEPLOYMENT_EXPOSURE=private`, `SERVE_UI=false`. Условия обеих сторон идентичны: одно dist-дерево, один PG-кластер, процессная группа убивается между ранами.

## Результаты (3+3, секунды до 200 /api/health)

| Сторона | r1 | r2 | r3 | медиана |
|---|---|---|---|---|
| БЫЛО (tsx-loader на dist) | 16.409 | 17.475 | 15.322 | **16.409** |
| СТАЛО (bare node на dist) | 13.116 | 12.910 | 14.028 | **13.116** |

Выигрыш **1.25×**. Критерий ≥2× не достигнут: при базовой 16.409 с нужно СТАЛО ≤ 8.2 с.

Примечание: ранние замеры (tsx на src, 22.666/17.480) включали другой профиль PG и загрязнение порта чужим инстансом; текущая таблица — чистое A/B, ей и верить.

## Профиль остаточных тормозов (node --cpu-prof, bare dist boot)
- `resolveServerVersion` (git describe через execFileSync, version.js): ~354 мс
- `readGitInfo` server-info.js (3 spawnSync: describe+status+branch): ~1355 мс
- разрешение модулей (`package_json_reader.get` inclusive): ~2.2 с
- компиляция модулей (compileSourceTextModule inclusive): ~1.6 с
- Итого git-spawnSync на старте ~1.7 с — прямой кандидат: выпекать version/commit при сборке (dist уже содержит build-version.js/build-commit.js) и лениво читать git-info.

## Команды повтора
```sh
pnpm --filter "@myrmidon/server^..." --filter "!@myrmidon/paperclip-runner" build
pnpm --filter @myrmidon/paperclip-runner build:typescript
node scripts/myrmidon/prod-runtime-exports.mjs apply --entry @myrmidon/server
# esbuild-transform server/src -> server/dist (см. NOTES.md в workspace задачи)
PORT=3199 HOST=127.0.0.1 MYRMIDON_DEPLOYMENT_MODE=local_trusted MYRMIDON_DEPLOYMENT_EXPOSURE=private SERVE_UI=false \
  node scripts/myrmidon/measure-board-start.mjs --cwd . --cmd "node server/dist/index.js" --runs 3 --port 3199 --json
# БЫЛО: --cmd "node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js"
```
