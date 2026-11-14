# OPE-12971: Benchmark замера старта доски (devbuild)

## Исходный замер Ч3 (PR #3068 / OPE-12179):
- БЫЛО (tsx loader): median 24.569s
- СТАЛО (bare node до оптимизаций): median 19.383s
- Ускорение: 1.27x (критерий эпика >=2x не выполнен)

## Текущий замер (PR #3102 head `67980f8bbe884ec27d2480be6dcb02ca0714c729`):
Команды запуска: `scripts/myrmidon/measure-board-start.mjs` на devbuild.

### СТАЛО (bare node):
- Run 1 (cold): 14.823s
- Run 2 (warm): 14.105s
- Run 3 (warm): 13.604s
- **Median: 14.105s** (ускорение относительно исходного БЫЛО 24.569s составляет **1.74x**)

### БЫЛО (tsx loader на текущей ветке):
- Run 1 (cold): 17.963s
- Run 2 (warm): 18.204s
- Run 3 (warm): 18.688s
- **Median: 18.204s**

## Анализ узких мест для достижения >=2x (цель: warm < 12.28s):
Профилирование top-level импортов в `server/src/app.ts` и `server/src/index.ts`:
1. `routes/ai-connections.js` -> 7.4s на импорт!
   - Тянет `services/local-ai-login.js` -> `services/ai-connections.js` -> `services/secrets.js` -> `adapters/index.js` (все адаптеры claude, codex, cursor, gemini, etc.)
2. `services/run-failure-report.js` в `index.ts`: 2.5s
3. `services/native-runtime/native-session-executor.js` в `index.ts`: 5.0s
4. Отложенная регистрация / ленивые импорты в этих 3 точках дадут выигрыш ещё 4-7s и доведут тёплый старт до ~8-9s (>2.7x ускорение).
