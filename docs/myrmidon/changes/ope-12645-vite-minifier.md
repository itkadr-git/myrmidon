---
divergence-section: Трек 1 — платформа
---

## divergence

| OPE-12645 | Перенос удаления console/debugger и legalComments в конфигурацию минификатора Vite 8 (oxc/rolldown) в production, устранение конфликта с esbuild-опциями | `ui/vite.config.ts`; + `ui/src/lib/vite-build-options.myrmidon.test.ts` | OPE-12645: предупреждение «Both esbuild and oxc options were set», esbuild-опции игнорировались Vite 8 | `ui/src/lib/vite-build-options.myrmidon.test.ts` | Никогда, конфигурация сборки UI под Vite 8/oxc | (этот PR) |

## divergence-append

<!-- section: Трек 1 — платформа -->
Замер продакшен-бандла UI к строке OPE-12645 (PR #2882, head f3e7804611; devbuild 10–12.11.2026, vite 8.2.2 / rolldown 1.2.5; «до» — дерево main c584c84306, собранное той же сборкой): предупреждение «Both esbuild and oxc options were set» в логе сборки 1 → 0; вхождений `console.` в `ui/dist/assets/*.js` 50 → 59 (+9: esbuild `drop` заменял ссылку `console.x` на `()=>{}` даже в bind-позициях логгера mermaid, oxc `dropConsole` убирает только прямые вызовы — прямых вызовов `console.*(...)` 5 → 4; весь прирост — bind/fallback-ссылки в чанке `src-*.js`); `debugger` 7 → 7 (строковые литералы coffeescript/codemirror/i18n, не операторы); комментариев `/*!` 0 → 0; суммарный размер `ui/dist/assets/*.js` 18 769 833 → 18 535 246 байт (−229,5 КБ).
