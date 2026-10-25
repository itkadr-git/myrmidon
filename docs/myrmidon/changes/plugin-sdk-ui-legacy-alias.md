---
divergence-section: Трек 1 — платформа
---

## changelog-en

### UI of plugins built against `@paperclipai/plugin-sdk` loads again

- After the debranding, the host only substituted `@myrmidon/plugin-sdk/ui` and
  `/ui/hooks` in plugin UI bundles. Plugins built with `@paperclipai/plugin-sdk/ui` kept
  as an external import (Google AI, ChatGPT, Antigravity, license issuing, LLM Wiki and
  third-party Paperclip ecosystem plugins) failed to load their sidebar UI. The legacy
  names are substituted with the same shim again, in both quote styles.

## changelog-ru

### UI плагинов, собранных против `@paperclipai/plugin-sdk`, снова загружается

- После дебрендинга хост подменял в UI-бандлах плагинов только `@myrmidon/plugin-sdk/ui`
  и `/ui/hooks`. Плагины, собранные с внешним импортом `@paperclipai/plugin-sdk/ui`
  (Google AI, ChatGPT, Antigravity, «Выпуск лицензий», LLM Wiki и сторонние плагины
  экосистемы Paperclip), не загружали интерфейс в сайдбаре. Старые имена снова
  подменяются тем же shim, в обеих формах кавычек.

## divergence

| 1.6.6-PLUGIN-SDK-ALIAS | Алиасы `@paperclipai/plugin-sdk/ui` и `/ui/hooks` в карте подмены импортов UI-бандлов плагинов | `ui/src/plugins/slots.tsx` (метка `myrmidon(PLUGIN-SDK-ALIAS)`) | Совместимость с плагинами, собранными против upstream-имени SDK | `ui/src/plugins/slots.test.ts` (подмена `@paperclipai` равна подмене `@myrmidon`) | Удалить, когда все плагины пересоберут против `@myrmidon/plugin-sdk` | (этот PR) |
