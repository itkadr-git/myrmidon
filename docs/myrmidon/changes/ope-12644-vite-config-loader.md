---
divergence-section: 1.7 — UI-2.0: тесты разделов настроек (OPE-10138)
---

## divergence

| 1.7-UI-VITE-CONFIG-LOADER | Файл `ui/vite.config.ts` загружается любым загрузчиком Vite (включая будущий `native` по умолчанию): три относительных импорта получили `.ts` расширение, `__dirname` заменён на `import.meta.dirname` с fallback через `fileURLToPath(import.meta.url)` | `ui/vite.config.ts` | Устранение предупреждения Vite о неподдерживаемых возможностях в `configLoader: 'native'` (OPE-12644) | `ui/src/lib/vite-config-paths.myrmidon.test.ts` | Никогда, наше поведение (поддержка `configLoader: 'native'`) | (этот PR) |
