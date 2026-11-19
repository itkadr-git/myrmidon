# OPE-12179 Ч3 — замер старта было/стало (v5, чистый main, только измерение)

Дата: 2026-11-13. Дерево замера: pristine `origin/main` @ `6df7ee5df`
(без правок кода). Предыдущие версии замера (v3/v4) сопровождались
экспериментальным кодом ленивых импортов; по замечанию ревью PR #3140 код
убран из сдачи: этот PR — только измерение, профиль и команды повтора.
Экспериментальная ветка с ленивыми импортами сохранена отдельно:
`bot/OPE-12179-savepoint-lazy`.

## Метод
- Дерево: чистый `origin/main` (6df7ee5df). Во время прогонов каталог `.git`
  отсутствует (прод-стиль), коммит задан env-стэмпом `MYRMIDON_BUILD_COMMIT`.
- dist собран esbuild-трансформацией server/src → server/dist (без
  type-check: полный tsc в контейнере агента OOM при 4 GiB cgroup;
  команда репо-сборки для хоста с большим объёмом памяти — ниже).
- Замыкание собрано штатно: `pnpm --filter "@myrmidon/server^..." --filter
  "!@myrmidon/paperclip-runner" build` + `pnpm --filter
  @myrmidon/paperclip-runner build:typescript`.
- Прод-разрешение пакетов: `node scripts/myrmidon/prod-runtime-exports.mjs
  apply --entry @myrmidon/server` + vendor-шимы
  `server/dist/vendor/paperclip-runner/*.js` переключены на `dist`
  (только в рантайме замера, в коммит не входит).
- Харнесс: `scripts/myrmidon/measure-board-start.mjs --runs 3 --port 3199`,
  embedded PGlite, `MYRMIDON_DEPLOYMENT_MODE=local_trusted`,
  `MYRMIDON_DEPLOYMENT_EXPOSURE=private`, `SERVE_UI=false`.
- Протокол: четыре блока с чередованием порядка (bare → tsx → bare → tsx),
  один dist-дерево, один PG-кластер, процессная группа убивается между
  ранами — перекос порядка исключён.

## Результаты (3+3+3+3, секунды до 200 /api/health)

| Блок | r1 | r2 | r3 | медиана блока |
|---|---|---|---|---|
| СТАЛО (bare) блок 1 | 15.827 | 17.128 | 14.079 | 15.827 |
| БЫЛО (tsx) блок 1 | 21.759 | 22.176 | 19.222 | 21.759 |
| СТАЛО (bare) блок 2 | 15.113 | 14.006 | 15.096 | 15.096 |
| БЫЛО (tsx) блок 2 | 18.258 | 20.227 | 19.002 | 19.002 |

| Сторона | объединённые медианы | итог |
|---|---|---|
| БЫЛО (tsx-loader на dist) | 21.759 / 19.002 → **19.7 с** | базовая |
| СТАЛО (bare node на dist) | 15.827 / 15.096 → **15.1 с** | **1.31×** |

Сырые замеры: `report/OPE-12179-measure-main.json` (все 4 блока, команды и
окружение внутри). Критерий эпика ≥2× не достигнут: при базовой ~19.7 с
нужно СТАЛО ≤ ~9.9 с; измерено 15.1 с.

## Профиль остаточных тормозов (node --cpu-prof, bare boot, чистый main)
- до готовности в профилированном прогоне ~12.5 с CPU-активности
  (остальное — ожидание PGlite/сети);
- разрешение модулей (`package_json_reader`, self): ~1.2 с;
- компиляция модулей (`compileSourceTextModule`): ~1.42 с;
- GC: ~2.86 с;
- git-spawnSync (self 385 мс): три места вызовов на gitless-дереве —
  `server/src/version.ts` (git describe), `server/src/server-info.ts`
  (describe+status+branch), `server/src/instrumentation.ts`
  (rev-parse при каждом старте). В проде та же цена (~340 мс на неудачный
  вызов): стэмпы version/commit уже читаются из env/файлов сборки, но
  git-вызовы всё равно выполняются до fallback — кандидат на ленивую
  инициализацию/кэш.
- Инициализационный граф `@myrmidon/db` — крупнейший блок (по профилю
  предыдущей версии ~3.9 с), заведён в задачу-продолжение #3085.

## Команды повтора
```sh
# штатная сборка репо (нужен хост без 4 GiB-лимита: полный tsc)
pnpm --filter "@myrmidon/server^..." --filter "!@myrmidon/paperclip-runner" build
pnpm --filter @myrmidon/paperclip-runner build:typescript
node scripts/myrmidon/prod-runtime-exports.mjs apply --entry @myrmidon/server
# в этом замере dist получен esbuild-трансформацией server/src -> server/dist:
#   node scripts/myrmidon/… (см. OPE-12179-measure-main.json, поле dist)
MYRMIDON_BUILD_COMMIT=$(git rev-parse HEAD) \
PORT=3199 HOST=127.0.0.1 MYRMIDON_DEPLOYMENT_MODE=local_trusted \
MYRMIDON_DEPLOYMENT_EXPOSURE=private SERVE_UI=false \
  node scripts/myrmidon/measure-board-start.mjs --cwd . \
  --cmd "node server/dist/index.js" --runs 3 --port 3199 --json
# БЫЛО: --cmd "node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js"
```

## История замеров (прозрачность)
- v3 (дерево с ленивыми импортами, tsx-загрузчик БЫЛО): 16.409 → 13.116 =
  1.25× — цифра смешана с эффектом правок кода, не чистый main.
- v4 (тот же код, прод-стиль без .git + env-стэмпы): СТАЛО 13.687 = 1.25×.
- v5 (этот отчёт): чистый `origin/main`, эффект перехода tsx→bare без
  смешивания; итог 1.31×.

## Гигиена (ADM 04:21)
- `/tmp/bench-12179` не существует; в раннере распаковок слоёв образа нет.
- Повторные замеры с распаковкой образа — только на сборочной машине через
  devbuild; в раннере выполнялись только сборки из исходников.
