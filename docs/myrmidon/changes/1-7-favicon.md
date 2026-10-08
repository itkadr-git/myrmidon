---
divergence-section: Брендинг
---

## changelog-en

### Tab and home-screen icon — Myrmidon ant mark (1.7 FAVICON)

- The browser tab and the phone home screen ship the Myrmidon ant mark from
  the design-system export (`ui/public/brand/myrmidon/`): `favicon.svg` (the
  bare mark, adaptive navy/white), `favicon.ico` (16/32/48), 16/32 px PNGs for
  the tab, `apple-touch-icon.png` (180) and `android-chrome-192/512.png`
  (maskable 512 included) for the home screen, referenced from `index.html`
  and `site.webmanifest`; no vendor paperclip artwork ships. Icon and manifest
  URLs are served with `?v=<build version>` so a deploy refreshes the browser
  icon store.
- New guard test `ui/src/lib/myrmidon-favicon-build.myrmidon.test.ts`: the
  page links the full tab icon set, the manifest carries the 192/512 icons
  (incl. maskable), a built `ui/dist` ships the same ant files, and no
  paperclip artwork remains in `ui/public`.
- Guide: [favicon.md](../guides/favicon.md) (EN) and
  [favicon.ru.md](../guides/favicon.ru.md) (RU).

## changelog-ru

### Знак во вкладке и на домашнем экране — муравей Myrmidon (1.7 FAVICON)

- Во вкладке браузера и на домашнем экране телефона отгружается знак Myrmidon
  из экспорта дизайн-системы (`ui/public/brand/myrmidon/`): `favicon.svg` (сам
  знак, адаптивный navy/белый), `favicon.ico` (16/32/48), PNG 16/32 для
  вкладки, `apple-touch-icon.png` (180) и `android-chrome-192/512.png` (включая
  maskable 512) для домашнего экрана, подключённые из `index.html` и
  `site.webmanifest`; графика скрепки вендора не отгружается. URL значков и
  манифеста отдаются с `?v=<версия сборки>`, поэтому выкат обновляет значок в
  браузере.
- Новый тест-сторож `ui/src/lib/myrmidon-favicon-build.myrmidon.test.ts`:
  страница ссылается на полный набор значков вкладки, манифест несёт значки
  192/512 (включая maskable), собранный `ui/dist` отгружает те же файлы
  муравья, и в `ui/public` не остаётся графики скрепки.
- Руководство: [favicon.md](../guides/favicon.md) (EN) и
  [favicon.ru.md](../guides/favicon.ru.md) (RU).

## divergence

| FAVICON | Значок вкладки и домашнего экрана — знак Myrmidon из экспорта дизайн-системы (набор отгружен в B1a/1.1.0, подтверждён заново для 1.7): набор файлов значков, ссылки из `index.html` и отдача с версией сборки покрыты новым сторожем сборки; изменений вендорских файлов в этом PR нет | — (вендорские файлы не тронуты; сторож ссылается на `ui/public/site.webmanifest`, `ui/public/favicon*`, `ui/public/brand/myrmidon/**`); + `ui/src/lib/myrmidon-favicon-build.myrmidon.test.ts`, `docs/myrmidon/guides/favicon{,.ru}.md` | 1.7 FAVICON (OPE-4160): во вкладке и на домашнем экране — знак Myrmidon, скрепки нигде нет | `ui/src/lib/myrmidon-favicon-build.myrmidon.test.ts` (+ действующие `myrmidon-branding-guard.myrmidon.test.ts`, `myrmidon-ant-mark.myrmidon.test.ts`) | Никогда, наше поведение. При переносе: сохранить файлы значков как копии `ui/public/brand/myrmidon/**`; сторож ловит регрессию набора и возврат графики скрепки | #724 |
