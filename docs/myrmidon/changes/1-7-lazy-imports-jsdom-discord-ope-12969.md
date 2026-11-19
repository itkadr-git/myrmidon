## changelog-en

### Lazy load jsdom and @chat-adapter/discord in server startup paths (BOARD-START-BUNDLE, OPE-12969)

- Top-level imports of `jsdom` and `@chat-adapter/discord` accounted for ~1.7s of module evaluation overhead during server cold start.
- Migrated `routes/assets.ts`, `services/announcement-animation.ts`, and `services/chat-github-attachments.ts` to lazy dynamic `import("jsdom")` inside SVG sanitization, animation validation, and GitHub comment attachment target resolution.
- Migrated `services/chat-discord.ts` to instantiate `DiscordFormatConverter` on first use via lazy dynamic `import("@chat-adapter/discord")` inside `discordMarkdownRequiresAttachment`.
- Updated all call sites and test suites to handle async execution. Added `lazy-imports.myrmidon.test.ts` to enforce absence of top-level value imports.

## changelog-ru

### Ленивая загрузка jsdom и @chat-adapter/discord в путях запуска сервера (BOARD-START-BUNDLE, OPE-12969)

- Верхнеуровневые импорты `jsdom` и `@chat-adapter/discord` давали ~1.7с накладных расходов на инициализацию модулей при старте сервера.
- В `routes/assets.ts`, `services/announcement-animation.ts` и `services/chat-github-attachments.ts` импорт `jsdom` переведён на динамический `await import("jsdom")` в точках вызова (санитизация SVG, валидация анимаций и разбор вложений GitHub).
- В `services/chat-discord.ts` создание `DiscordFormatConverter` переведено на ленивую инициализацию через `await import("@chat-adapter/discord")` при первом вызове `discordMarkdownRequiresAttachment`.
- Все вызывающие места и тесты обновлены для поддержки асинхронного вызова. Добавлен регрессионный тест `lazy-imports.myrmidon.test.ts`, запрещающий верхнеуровневый импорт значений из этих библиотек.
