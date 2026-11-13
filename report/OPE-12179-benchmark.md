# OPE-12179 Ч3: результаты замеров старта доски (было/стало)

Дата замера: 2026-11-13. Коммит дерева: `d8c425bce` (bot/OPE-12179), замер выполнялся на **prod-дереве из официального CI-образа** `ghcr.io/itkadr-git/myrmidon:main`, amd64, digest `sha256:b52165d83fa8365437642c0…` (config created 2026-11-13T03:50Z, Cmd = tsx-loader вариант).

## Метод

Харнесс: `scripts/myrmidon/measure-board-start.mjs` (уже в main, OPE-12614). Spawn процесса, poll `GET /api/health` каждые 100 мс, время от spawn до первого HTTP 200. Холодный прогон = первый, тёплые = 2–3 (данные PGlite сохраняются между прогонами — миграции применяются один раз).

Дерево: два наибольших слоя образа (`sha256:5ab3dd74…` 916 МБ, `sha256:9ddac90c…` 859 МБ) распакованы в общий корень, где `server/dist` уже собран CI. Замер обоих вариантов — на **одном и том же дереве**, отличается только команда старта. Это устраняет разницу между «dev-деревом tsx» и «prod-деревом»: тот же JS, те же node_modules, та же БД.

## Команды повтора

```sh
# СТАЛО (bare node, вариант из PR #3033):
node scripts/myrmidon/measure-board-start.mjs --cwd . \
  --cmd "node server/dist/index.js" --runs 3 --port 3199 --timeout-sec 120 \
  --env HOST=127.0.0.1 --env PAPERCLIP_DEPLOYMENT_MODE=local_trusted \
  --env PAPERCLIP_DEPLOYMENT_EXPOSURE=private --json

# БЫЛО (tsx loader, вариант из Dockerfile до #3033):
node scripts/myrmidon/measure-board-start.mjs --cwd . \
  --cmd "node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js" \
  --runs 3 --port 3199 --timeout-sec 180 \
  --env HOST=127.0.0.1 --env PAPERCLIP_DEPLOYMENT_MODE=local_trusted \
  --env PAPERCLIP_DEPLOYMENT_EXPOSURE=private --json
```

(на prod-дереве из образа; для сборки с нуля — `pnpm --filter "@myrmidon/server^..." --filter "!@myrmidon/paperclip-runner" build`, затем `pnpm --filter @myrmidon/paperclip-runner build:typescript`, затем `node scripts/myrmidon/prod-runtime-exports.mjs apply --entry @myrmidon/server`)

## Результаты

### БЫЛО — `node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js`

| Прогон | Секунды | Примечание |
| --- | --- | --- |
| 1 | 24.569 | холодный |
| 2 | 22.471 | тёплый |
| 3 | 27.294 | тёплый |

min 22.471 / **median 24.569** / max 27.294

### СТАЛО — `node server/dist/index.js`

| Прогон | Секунды | Примечание |
| --- | --- | --- |
| 1 | 19.383 | холодный |
| 2 | 23.236 | тёплый |
| 3 | 16.654 | тёплый |

min 16.654 / **median 19.383** / max 23.236

### Итог

| Метрика | БЫЛО | СТАЛО | Улучшение |
| --- | --- | --- | --- |
| Медиана | 24.569 с | 19.383 с | **1.27×** |
| Минимум | 22.471 с | 16.654 с | 1.35× |

**Критерий приёмки «тёплый старт СТАЛО быстрее БЫЛО минимум в 2 раза» — НЕ выполнен (1.27×).**

## Разбор: где время

Профиль загрузки модулей (node `--cpu-prof` на старте СТАЛО):

- `import('./dist/app.js')` — **14.1 с** только на загрузку модулей (до открытия листнера).
- Основные тяжёлые import (измерено по отдельности): `@myrmidon/db` — **3.9 с**, `jsdom` — **0.9 с**, `@chat-adapter/discord` — **0.8 с**, `express` — 0.2 с.
- Самозатраты CPU: парсинг `package.json` + компиляция ESM (Node internals) — ~5.3 с, GC ~1.5 с, `zod/v4` schemas ~0.8 с, `@cursor/sdk` (rxjs CJS-граф) ~0.2 с.
- Дисковая фаза (first-run миграции PGlite, 398 шт.) — вне измерения старта: они идут после `listen()`.

То есть tsx-компиляция — не главный тормоз (его устранение даёт 1.27×). Главные тормоза: (а) **гигантский статический import-граф сервера** (~3846 модулей), (б) тяжёлые top-level imports (`jsdom` в `announcement-animation.js`/`chat-github-attachments.js`/`routes/assets.js`; `@chat-adapter/discord` в `chat-discord.js` через `chat-channels.js`; `@myrmidon/db` на всём графе).

## Следующий шаг (план п.3: если выигрыш <2×)

Динамические (`await import()`) загрузки тяжёлых зависимостей в точках фактического использования дадут основную часть оставшихся ~19 с: `jsdom` и `@chat-adapter/discord` — только в путях чата/анонсов, `@myrmidon/db` — разделить на схему-инициализацию и клиент-инициализацию. Отдельная задача на ленивые импорты с этими данными.
