---
divergence-section: Трек 1 — платформа
---

## changelog-en

### Knowledge screen in the current interface

- After the wiki plugin was retired, the side menu of the current interface lost its wiki
  entry and the module's reader existed only in UI2. The current interface now has a
  "Knowledge" menu item and the screens `/:companyPrefix/wiki` and
  `/:companyPrefix/wiki/:spaceKey/:slug`: page tree, search (full-text and semantic), the page
  with its sources, backlinks and revisions.
- The screen reuses the UI2 reader and reads the knowledge module through the existing REST
  facade (`/api/myrmidon/companies/:id/knowledge/*`: items, search, backlinks). Backlinks are
  now actually loaded and shown as links to the linking pages.

## changelog-ru

### Экран «Знания» в текущем интерфейсе

- После вывода плагина вики из бокового меню текущего интерфейса пропал пункт вики, а
  читалка модуля knowledge была только в UI2. В текущем интерфейсе появился пункт меню
  «Знания» и экраны `/:companyPrefix/wiki` и `/:companyPrefix/wiki/:spaceKey/:slug`: дерево
  страниц, поиск (полнотекстовый и семантический), страница с источниками, обратными ссылками
  и ревизиями.
- Экран переиспользует читалку UI2 и ходит в модуль knowledge через существующий REST
  (`/api/myrmidon/companies/:id/knowledge/*`: items, search, backlinks). Обратные ссылки
  теперь реально загружаются и показываются ссылками на страницы-источники.

## divergence

| 1.6.6-KNOWLEDGE-SCREEN | Экран «Знания» в текущем UI: маршруты `wiki` и `wiki/:spaceKey/:slug`, пункт бокового меню, параметр `basePath` у читалки UI2, загрузка обратных ссылок | `ui/src/ui2/screens/knowledge/Ui2KnowledgeCurrentUi.tsx`, метки `myrmidon(OPE-9222)` в `ui/src/App.tsx`, `ui/src/components/Sidebar.tsx`, `ui/src/lib/company-routes.ts`, `ui/src/ui2/screens/knowledge/*`, ключи `nav.knowledge` в `ui/src/i18n/myrmidon-locales/{en,ru}.json` | Плагин вики выведен, а читалка модуля knowledge жила только в UI2: в текущем интерфейсе знаний не открыть | `ui/src/ui2/screens/knowledge/Ui2KnowledgeCurrentUi.myrmidon.test.tsx`, `ui/src/components/Sidebar.myrmidon-navigation.test.tsx` | Когда текущий интерфейс заменит UI2 — удалить обёртку и метки | (этот PR) |
