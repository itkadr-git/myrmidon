---
divergence-section: Брендинг
---

## changelog-en

### Browser storage keys and internal events debranded: `paperclip.*` → `myrmidon.*` with migration (DB3)

- All localStorage/sessionStorage keys and internal `window` CustomEvent names in the web UI were renamed from the `paperclip.*` / `paperclip:*` brand forms to `myrmidon.*` / `myrmidon:*`, preserving the original separator style of each key (dot, colon, composite `:<id>:paperclip:` → `:<id>:myrmidon:`).
- Settings survive the upgrade: `ui/src/lib/storage-brand-migration.ts` provides lazy read-migration (`readMigratedStorageItem`: read new key, fall back to the legacy key, copy the value forward, delete the legacy key) plus a one-time startup sweep (`migrateLegacyPaperclipStorage`, invoked from `ui/src/main.tsx` before first render). The inline theme script in `ui/index.html` migrates `paperclip.theme` → `myrmidon.theme` synchronously before first paint, so there is no theme flash.
- Writes always go to the new key only. Legacy keys are read only by the migration code.
- Out of scope (later DEBRAND stages): wire/protocol schemas (`paperclip.*.v1`), pluginKey identifiers, `X-Paperclip-*` headers, CSS classes, the Honeycomb run-hash attribute, and the `connection-intent` postMessage type — these are identifiers exchanged with external services or upstream vendor code.

## changelog-ru

### Ключи браузерного хранилища и внутренние события дебрендированы: `paperclip.*` → `myrmidon.*` с миграцией (DB3)

- Все ключи localStorage/sessionStorage и имена внутренних `window` CustomEvent в веб-UI переименованы из брендовых форм `paperclip.*` / `paperclip:*` в `myrmidon.*` / `myrmidon:*` с сохранением стиля разделителя исходного ключа (точка, двоеточие, составные `:<id>:paperclip:` → `:<id>:myrmidon:`).
- Настройки при апгрейде не теряются: `ui/src/lib/storage-brand-migration.ts` даёт ленивую миграцию при чтении (`readMigratedStorageItem`: читаем новый ключ, при пустоте — старый, переносим значение, старый удаляем) и единовременный стартовый свип (`migrateLegacyPaperclipStorage`, вызывается из `ui/src/main.tsx` до первого рендера). Inline-скрипт темы в `ui/index.html` мигрирует `paperclip.theme` → `myrmidon.theme` синхронно до первой отрисовки — без вспышки темы.
- Запись всегда идёт только в новый ключ. Старые ключи читает только код миграции.
- Вне скоупа (следующие этапы DEBRAND): протокольные схемы `paperclip.*.v1`, идентификаторы pluginKey, заголовки `X-Paperclip-*`, CSS-классы, атрибут Honeycomb run-hash и postMessage-тип `connection-intent` — это идентификаторы, обмениваемые с внешними сервисами или кодом вендора.

## divergence

| DB3 | Ключи браузерного хранилища и внутренние события веб-UI переименованы `paperclip.*`/`paperclip:*` → `myrmidon.*`/`myrmidon:*` (~56 литералов + составные формы, 58 файлов: ThemeContext/SidebarContext/CompanyContext/PanelContext, recent-*, composer-draft, task-collection-preferences, inbox, attention, import-job-watch, invite-memory, oauthHandoff, cross-tab-poll, bridge-init, plugins, ui2, storybook-прототипы). Миграция без потери настроек: ленивое чтение через `readMigratedStorageItem` + стартовый свип `migrateLegacyPaperclipStorage` из `main.tsx`; `paperclip.theme` мигрируется inline-скриптом `index.html` синхронно до первой отрисовки. Запись — только в новый ключ; старые читают только код миграции | ui/src (lib/, context/, hooks/, pages/, components/, features/connections/, plugins/, ui2/, api/, lib/storage-brand-migration.ts + test), ui/index.html, ui/storybook | DEBRAND 1.6.6-c (OPE-5806, ROADMAP OPE-5794): брендовые идентификаторы хранилища вычищаются с гарантией сохранения пользовательских настроек | Новый юнит-тест `ui/src/lib/storage-brand-migration.test.ts` (старый ключ → новый, старый удалён; запись в новый; sweep составных/префиксных форм; legacy-список не пересекается с новым пространством); фикстуры существующих тестов переведены на новые ключи, намеренные legacy-миграционные кейсы (recent-tasks) сохранены; гейт `grep '"paperclip[.:]' ui/src ui/index.html` чист вне кода миграции | Никогда, наше пространство имён хранилища. Новые ключи — только `myrmidon.*`; legacy-чтение держать в storage-brand-migration (метка myrmidon(DB3)) | OPE-5806 (1.6.6 DEBRAND-c) |
