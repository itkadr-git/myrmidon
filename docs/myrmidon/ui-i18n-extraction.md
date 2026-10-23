# UI i18n extraction: moving hard-coded strings into catalogs

English first, Russian below / Русская версия ниже.

## English

Wave plan: `ui/src/i18n/guarded/_areas.md` (areas, files, string counts). One PR takes one area.

### Which mechanism
- Current UI (everything outside `ui/src/ui2`): i18next. `useTranslation()` in components, `t()` / `i18n.t()` from `@/i18n` elsewhere.
- UI2 (`ui/src/ui2`) has its own typed catalog (`ui2/i18n/locales.ts`, `useUi2T`). Do not touch it; merging it into one mechanism is a separate task.

### Where catalogs live
- `ui/src/i18n/myrmidon-locales/areas/<area>.en.json` and `<area>.ru.json`. Both are required. The language comes from the file name suffix.
- Do not edit `en.json`, `ru.json` or vendor `locales/` in an extraction PR: parallel PRs would conflict. The one exception is `areas/common.*.json`, see "Shared words".
- Every key lives under `area.<area>.*`: the file has exactly one top-level key `area`, holding exactly one key `<area>`.
- Files are deep-merged. A key defined in two files, or a string in one file against an object in another, is a test error.

### Key naming
`area.<area>.<screen>.<what>`, camelCase for `<what>`.
- `<screen>` is the file name without extension, in kebab-case: `IssueProperties.tsx` -> `issue-properties`.
- A file with several components gets a sub-key per component: `area.x.issue-properties.labelPicker.title`.
- `<what>` names the role (title, description, placeholder, createButton, emptyTitle, deleteConfirm), not the text.

### Shared words
Save, Cancel, Delete, Close and the like are never duplicated per area.
1. Use an existing `common.*` key from `en.json` (`common.save`, `common.cancel`, `common.close`, ...).
2. If there is none, add it to `areas/common.en.json` and `areas/common.ru.json` (key `area.common.*`). The `common` area is one: only the PR that first needs the word edits it. Other PRs wait for it to merge, or use an existing key.

### Interpolation and plurals
- Variables: `"deleted": "Deleted {{name}}"`, call `t("area.x.s.deleted", { name })`. Never concatenate translated fragments.
- Plurals: i18next suffixes, call with `count`. A group is two or more suffixed forms of one key. en needs `_one` + `_other`; ru needs `_one` + `_few` + `_many` + `_other`. The catalog test checks the full set per language and compares `{{placeholders}}` per group.
- Markup inside a sentence: `<Trans>` with indexed tags; do not split the sentence.

### Strings outside JSX
Toasts, constants, option lists, column titles and `.ts` files: do not keep English at module level (it freezes the language at import). Call `i18n.t("area....")` at the place of use, or make the constant a lazy function (`const options = () => [{ label: i18n.t("area....") }]`) and call it in render.

### Dates and numbers
Do not put dates or numbers into catalog strings. Format with `Intl` / `toLocaleString(i18n.language)` at the place and pass the result as an interpolation value. Note: the shared formatters in `ui/src/lib/utils.ts` (`formatDate`, `formatNumber`, ...) are hard-wired to `en-US`; do not change them inside an area PR (shared by all areas) - raise a separate task.

### Do not translate
Codes and enum values, identifiers, ids, `data-testid`, class names, URLs and routes, CLI commands, JSON/field names, product and protocol names (Myrmidon, LiteLLM...), and error messages that come from the server (show them as received).

### Guard and "done"
Create `ui/src/i18n/guarded/<area>.txt`: one path per line relative to `ui/src` (your area's files are in `_areas.md`), `#` starts a comment. Two tests then run on those files:
1. No English literals: multi-line JSX text, `{"..."}` string children, and the attributes alt, aria-label (and other textual aria-*), title, label, placeholder, tooltip, message, intro, description, emptyMessage with any letter in either quote style.
2. Every static `t("area....")` / `i18n.t("area....")` in those files exists in the en catalog.

An area is done when all its files are in `guarded/<area>.txt` and these tests are green.

**What the guard does not catch** (check by hand): template literals (`` `Deleted ${name}` ``), strings built in code, object fields and constants (`{ label: "Name" }`), ternary branches (`{ok ? "Yes" : "No"}`), `.ts` files, dynamic keys (`t(`area.x.${k}`)`), a wrong key that happens to exist. Green guard is necessary, not sufficient: grep the files of your area for quoted English before you finish.

### Example
`guarded/projects-1.txt`:
```
components/ProjectProperties.tsx
```
`myrmidon-locales/areas/projects-1.en.json`:
```json
{ "area": { "projects-1": { "project-properties": {
  "title": "Properties",
  "createButton": "Create project",
  "count_one": "{{count}} project",
  "count_other": "{{count}} projects"
} } } }
```
`projects-1.ru.json` has the same keys, with `count_one`, `count_few`, `count_many`, `count_other`. In code:
```tsx
const { t } = useTranslation();
<h2>{t("area.projects-1.project-properties.title")}</h2>
<Button>{t("area.projects-1.project-properties.createButton")}</Button>
<span>{t("area.projects-1.project-properties.count", { count: items.length })}</span>
<Button>{t("common.cancel")}</Button>
```
Tests run in CI only.

## Русский

План волны: `ui/src/i18n/guarded/_areas.md` (области, файлы, число надписей). Один PR берёт одну область.

### Какой механизм
- Текущий интерфейс (всё вне `ui/src/ui2`): i18next. В компонентах `useTranslation()`, вне их `t()` / `i18n.t()` из `@/i18n`.
- У UI2 (`ui/src/ui2`) свой типизированный каталог (`ui2/i18n/locales.ts`, `useUi2T`). Не трогать: сведение к одному механизму - отдельная задача.

### Куда класть каталоги
- `ui/src/i18n/myrmidon-locales/areas/<area>.en.json` и `<area>.ru.json`. Нужны оба. Язык берётся из суффикса имени файла.
- `en.json`, `ru.json` и вендорные `locales/` в PR выноса не править: параллельные PR будут конфликтовать. Единственное исключение - `areas/common.*.json`, см. «Общие слова».
- Все ключи только в `area.<area>.*`: в файле один ключ верхнего уровня `area`, в нём один ключ `<area>`.
- Файлы сливаются глубоко. Ключ в двух файлах и строка в одном файле против объекта в другом - ошибка теста.

### Имена ключей
`area.<area>.<screen>.<что>`, `<что>` в camelCase.
- `<screen>` - имя файла без расширения в kebab-case: `IssueProperties.tsx` -> `issue-properties`.
- Если в файле несколько компонентов, на каждый свой подключ: `area.x.issue-properties.labelPicker.title`.
- `<что>` - роль (title, description, placeholder, createButton, emptyTitle, deleteConfirm), а не сам текст.

### Общие слова
Save, Cancel, Delete, Close и подобные не дублируются по областям.
1. Берите существующий ключ `common.*` из `en.json` (`common.save`, `common.cancel`, `common.close`, ...).
2. Нужного нет - добавьте в `areas/common.en.json` и `areas/common.ru.json` (ключи `area.common.*`). Область `common` одна: её правит только PR, где слово понадобилось впервые. Остальные ждут его влития или берут существующий ключ.

### Интерполяция и множественные числа
- Переменные: `"deleted": "Удалено: {{name}}"`, вызов `t("area.x.s.deleted", { name })`. Переведённые куски не склеивать.
- Множественные: суффиксы i18next, вызов с `count`. Группа - две и более формы одного ключа. В en нужны `_one` + `_other`; в ru `_one` + `_few` + `_many` + `_other`. Тест каталогов проверяет полный набор форм для каждого языка и сравнивает `{{плейсхолдеры}}` по группе.
- Разметка внутри фразы: `<Trans>` с индексными тегами, предложение не дробить.

### Строки вне JSX
Toast, константы, списки опций, заголовки колонок и `.ts`-файлы: не держите английский на уровне модуля (язык замёрзнет при импорте). Вызывайте `i18n.t("area....")` в месте использования или сделайте константу ленивой функцией (`const options = () => [{ label: i18n.t("area....") }]`) и вызывайте её при рендере.

### Даты и числа
Даты и числа не кладите в строки каталога. Форматируйте через `Intl` / `toLocaleString(i18n.language)` на месте и передавайте результат как значение интерполяции. Общие форматтеры в `ui/src/lib/utils.ts` (`formatDate`, `formatNumber`, ...) жёстко привязаны к `en-US`; в PR области их не менять (общие для всех областей) - заведите отдельную задачу.

### Не переводить
Коды и значения enum, идентификаторы, id, `data-testid`, имена классов, URL и маршруты, команды CLI, имена полей JSON, названия продуктов и протоколов (Myrmidon, LiteLLM...), ошибки, пришедшие с сервера (показывать как есть).

### Защита и «готово»
Создайте `ui/src/i18n/guarded/<area>.txt`: по пути на строку относительно `ui/src` (файлы вашей области - в `_areas.md`), `#` - комментарий. На этих файлах работают два теста:
1. Нет английских литералов: многострочный JSX-текст, строковые дети `{"..."}`, атрибуты alt, aria-label (и другие текстовые aria-*), title, label, placeholder, tooltip, message, intro, description, emptyMessage - любая буква, обе кавычки.
2. Каждый статический `t("area....")` / `i18n.t("area....")` в этих файлах есть в en-каталоге.

Область готова, когда все её файлы в `guarded/<area>.txt` и эти тесты зелёные.

**Чего guard не ловит** (проверять руками): шаблонные строки (`` `Удалено ${name}` ``), строки, собранные в коде, поля объектов и константы (`{ label: "Name" }`), ветки тернарника (`{ok ? "Yes" : "No"}`), `.ts`-файлы, динамические ключи (`t(`area.x.${k}`)`), неверный ключ, который случайно существует. Зелёный guard необходим, но не достаточен: перед завершением найдите в файлах области английские строки в кавычках.

### Пример
См. английский раздел: `guarded/projects-1.txt`, `areas/projects-1.en.json` и `projects-1.ru.json` с теми же ключами (для ru `count_one/_few/_many/_other`), в коде `t("area.projects-1.project-properties.title")`, общее слово - `t("common.cancel")`. Тесты запускает только CI.
