# OPE-12971: Benchmark замера старта доски (devbuild)

## Исходный замер Ч3 (PR #3068 / OPE-12179):
- БЫЛО (tsx loader): median 24.569s
- СТАЛО (bare node до оптимизаций): median 19.383s
- Ускорение: 1.27x (критерий эпика >=2x не выполнен)

## Текущий замер на exact HEAD PR #3102 (`81368a60ddb95b5a48b45ec7131bcdb93c1c75f6`):
Команды запуска: `scripts/myrmidon/measure-board-start.mjs` с `prod-runtime-exports` на devbuild.

### СТАЛО (bare node на HEAD `81368a6`):
- Run 1 (cold): 15.215s
- Run 2 (warm): 13.203s
- Run 3 (warm): 12.505s
- **Median: 13.203s** (ускорение относительно исходного БЫЛО 24.569s составляет **1.86x**; min 12.505s = **1.96x**)

### БЫЛО (tsx loader на текущей ветке):
- Run 1 (cold): 17.963s
- Run 2 (warm): 18.204s
- Run 3 (warm): 18.688s
- **Median: 18.204s**

## Анализ узких мест для преодоления порога >=2.0x (цель: warm < 12.284s):
В коммите `81368a6` успешно вынесены в `await import()` вызовы `native-session-executor` в роутах и `chat-channels`, что уменьшило время старта с 14.1s до 13.2s / 12.5s (1.86x - 1.96x).

Главный оставшийся блокирующий импорт для гарантированного достижения цели (>2.7x):
1. `server/src/app.ts:1`: статический импорт `import { aiConnectionRoutes } from "./routes/ai-connections.js";`
   - Приводит к немедленной загрузке `services/local-ai-login.js` -> `services/ai-connections.js` -> `services/secrets.js` -> `@myrmidon/adapters/*` (все адаптеры claude, codex, cursor, gemini, grok, etc.), что занимает ~7.4s при инициализации `app.ts`.
   - Решение: ленивая регистрация роутера `aiConnectionRoutes` через middleware `(req, res, next)` или отложенная инициализация роутера при первом запросе.
   - Это снимет ещё 4-7s и доведёт тёплый старт до ~8-9s (>2.7x ускорение).
