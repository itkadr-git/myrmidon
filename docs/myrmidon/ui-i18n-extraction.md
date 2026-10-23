# UI i18n extraction: moving hard-coded strings into catalogs

English first, Russian below / Русская версия ниже.

## English

Plan of the wave: `ui/src/i18n/guarded/_areas.md` (areas, files, string counts). One PR takes one area.

### Which mechanism
- Current UI (everything outside `ui/src/ui2`): i18next. Use `useTranslation()` in components, `t()` from `@/i18n` elsewhere.
- UI2 (`ui/src/ui2`) has its own typed catalog (`ui2/i18n/locales.ts`, `useUi2T`). Do not mix: UI2 strings go there. The areas plan currently lists no UI2 files.

### Where catalogs live
- `ui/src/i18n/myrmidon-locales/areas/<area>.en.json` and `<area>.ru.json`. Both are required.
- The language comes from the file name suffix. Do not edit `en.json` / `ru.json` / vendor `locales/` in an extraction PR: parallel PRs would conflict.
- Every key lives under `area.<area>.*`: the file contains exactly one top-level key `area`, which contains exactly one key `<area>`.
- Files are deep-merged; a key defined in two files is a test error.

### Key naming
`area.<area>.<screen>.<what>` in camelCase, for example `area.pages-1.secrets.createButton`, `area.pages-1.secrets.emptyTitle`. `<screen>` is the component or page; `<what>` says the role (title, description, placeholder, button, error...), not the text.

### Interpolation and plurals
- Variables: `"deleted": "Deleted {{name}}"`, call `t("area.x.s.deleted", { name })`. Never concatenate translated fragments.
- Plurals: i18next suffixes, call with `count`. en needs `_one`, `_other`; ru needs `_one`, `_few`, `_many`, `_other`:
  `"items_one": "{{count}} item"`, `"items_other": "{{count}} items"`. The parity test folds plural suffixes, so ru may have more of them than en. `{{placeholders}}` must match between en and ru.
- Markup inside text: use `<Trans>` with indexed tags, do not split the sentence.

### Do not translate
Codes and enum values, identifiers, ids, `data-testid`, class names, URLs and routes, CLI commands, JSON/field names, product and protocol names (Myrmidon, LiteLLM...), and error messages that come from the server (show them as received).

### Guard
Create `ui/src/i18n/guarded/<area>.txt`: one path per line relative to `ui/src` (see `_areas.md` for your area). The test `legacy-screens-no-english` then fails on any English JSX text or `title/label/placeholder/...` attribute in those files. Lines starting with `#` are comments.

### Example
`guarded/pages-1.txt`:
```
pages/Secrets.tsx
```
`myrmidon-locales/areas/pages-1.en.json`:
```json
{ "area": { "pages-1": { "secrets": {
  "title": "Secrets",
  "createButton": "Create secret",
  "count_one": "{{count}} secret",
  "count_other": "{{count}} secrets"
} } } }
```
`pages-1.ru.json` has the same keys (`count_one/_few/_many/_other`). In code:
```tsx
const { t } = useTranslation();
<h1>{t("area.pages-1.secrets.title")}</h1>
<Button>{t("area.pages-1.secrets.createButton")}</Button>
<span>{t("area.pages-1.secrets.count", { count: items.length })}</span>
```
Checks: `areas` catalogs tests (no conflicts, own namespace, en/ru parity) and the guard test. Run through CI only.

## Русский

План волны: `ui/src/i18n/guarded/_areas.md` (области, файлы, число надписей). Один PR берёт одну область.

### Какой механизм
- Текущий интерфейс (всё вне `ui/src/ui2`): i18next. В компонентах `useTranslation()`, вне их `t()` из `@/i18n`.
- У UI2 (`ui/src/ui2`) свой типизированный каталог (`ui2/i18n/locales.ts`, `useUi2T`). Не смешивать: строки UI2 идут туда. В плане областей файлов UI2 сейчас нет.

### Куда класть каталоги
- `ui/src/i18n/myrmidon-locales/areas/<area>.en.json` и `<area>.ru.json`. Нужны оба.
- Язык берётся из суффикса имени файла. `en.json`, `ru.json` и вендорные `locales/` в PR выноса не трогать: параллельные PR будут конфликтовать.
- Все ключи только в `area.<area>.*`: в файле один ключ верхнего уровня `area`, в нём один ключ `<area>`.
- Файлы сливаются глубоко; ключ, определённый в двух файлах, - ошибка теста.

### Имена ключей
`area.<area>.<screen>.<что>` в camelCase, например `area.pages-1.secrets.createButton`, `area.pages-1.secrets.emptyTitle`. `<screen>` - компонент или страница; `<что>` - роль (title, description, placeholder, button, error...), а не сам текст.

### Интерполяция и множественные числа
- Переменные: `"deleted": "Удалено: {{name}}"`, вызов `t("area.x.s.deleted", { name })`. Переведённые куски не склеивать.
- Множественные: суффиксы i18next, вызов с `count`. В en нужны `_one`, `_other`; в ru - `_one`, `_few`, `_many`, `_other`. Тест полноты складывает суффиксы, поэтому в ru их может быть больше. `{{плейсхолдеры}}` в en и ru должны совпадать.
- Разметка внутри текста: `<Trans>` с индексными тегами, предложение не дробить.

### Не переводить
Коды и значения enum, идентификаторы, id, `data-testid`, имена классов, URL и маршруты, команды CLI, имена полей JSON, названия продуктов и протоколов (Myrmidon, LiteLLM...), ошибки, пришедшие с сервера (показывать как есть).

### Защита
Создайте `ui/src/i18n/guarded/<area>.txt`: по пути на строку относительно `ui/src` (файлы вашей области - в `_areas.md`). Тест `legacy-screens-no-english` упадёт на английском тексте JSX и атрибутах `title/label/placeholder/...` в этих файлах. Строки с `#` - комментарии.

### Пример
См. английский раздел выше: `guarded/pages-1.txt`, `areas/pages-1.en.json` и `pages-1.ru.json` с теми же ключами (для ru `count_one/_few/_many/_other`), в коде `t("area.pages-1.secrets.title")`. Тесты запускает только CI.
