# Лицензии зависимостей распространяемого образа

> English version: [licenses.md](licenses.md)

Статус: исследовательская записка для владельца. Факты собраны 25.10.2026 из
`pnpm-lock.yaml` и `Dockerfile` на `main`
(`a110c35de`), tarball'ов npm точных
зафиксированных версий и открытых текстов лицензий. Код не менялся; состав
образа решает владелец. Это инженерная оценка лицензионного риска, **не
юридическое заключение** и не юридическое разрешение на распространение.

## Контекст

Myrmidon — MIT-продукт, распространяемый как Docker-образ (multi-stage
`Dockerfile`, target `production`: `pnpm install --frozen-lockfile` → build →
runtime). Значимые для публикации зависимости сидят в исключениях
[`scripts/myrmidon/license-policy.json`](../../scripts/myrmidon/license-policy.json)
с пометкой «на решение сопровождающего»:

| Пакет | Версия | Лицензия | Как попадает в образ |
|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk` (+ `-linux-x64`, `-linux-x64-musl` в образе) | 0.3.263 | проприетарная (Anthropic) | prod-зависимости `@agentclientprotocol/claude-agent-acp` в `pnpm-lock.yaml` |
| `@cursor/sdk` (+ `@cursor/sdk-linux-x64` в образе) | 1.0.28 | проприетарная (Anysphere) | prod-зависимости `packages/adapters/cursor-cloud` в `pnpm-lock.yaml` |
| `@img/sharp-libvips-linux-x64`, `@img/sharp-libvips-linuxmusl-x64` | 1.3.3 | LGPL-3.0-or-later | необязательные платформенные зависимости `sharp` (prod) |
| `@anthropic-ai/claude-code` | 2.1.283 | проприетарная (Anthropic) | `npm install --global` в `Dockerfile` (`ARG CLAUDE_CODE_VERSION`), вне `pnpm-lock.yaml` и вне `license-policy.json` |

Образ собирается под `linux/amd64`, поэтому фактически в образ попадают
платформенные пакеты `linux-x64` (glibc); остальные платформенные пакеты
остаются только в lock-файле.

Три группы риска: проприетарные SDK под не-OSI условиями («All rights
reserved»), слабый копилефт LGPL-3.0 в перераспространяемом образе и объём
платформенных бинарников.

## Что говорят первичные тексты

### 1. `@anthropic-ai/claude-agent-sdk` 0.3.263

- `package.json` tarball'а: `"license": "SEE LICENSE IN README.md"`. README SDK
  отсылает к коммерческим юридическим соглашениям; открытой лицензии в tarball
  нет.
- `LICENSE.md` tarball'а (дословно): «© Anthropic PBC. All rights reserved. Use
  is subject to the Legal Agreements outlined here:
  https://code.claude.com/docs/en/legal-and-compliance».
- Условия, на которые он ссылается (Anthropic Commercial Terms,
  https://www.anthropic.com/legal/commercial-terms), разрешают *использование*
  — A.1 «permission to use the Services, including to power products and
  services Customer makes available to its own customers and end users» — то
  есть оператор, разворачивающий образ и запускающий агентов через SDK,
  покрыт в части использования.
- Перераспространение они **не** разрешают: F — «these Terms do not grant
  either party any rights to the other's content or intellectual property»;
  D.4 запрещает reverse engineering и дублирование сервисов. Пункта,
  разрешающего копирование или распространение бинарников SDK, нет.

Вывод: **перераспространение SDK внутри публикуемого MIT-образа первичными
текстами не лицензировано.** Формулировка «Redistributed unmodified in the
image» из текущего исключения `license-policy.json` этого не меняет: текстам
не на что опереться. Толерантна ли к этому Anthropic на практике — вопрос,
который решает только владелец (или сама Anthropic).

Источники: `package.json` и `LICENSE.md` tarball'а
`@anthropic-ai/claude-agent-sdk@0.3.263` (npm, анонимная загрузка);
https://code.claude.com/docs/en/legal-and-compliance;
https://www.anthropic.com/legal/commercial-terms (A.1, D.4, F).

### 2. `@cursor/sdk` 1.0.28

- `package.json` tarball'а: `"license": "SEE LICENSE IN LICENSE.md"`.
- `LICENSE.md` tarball'а (дословно): «Cursor SDK License — © Anysphere Inc. All
  rights reserved. Use is subject to Cursor's Terms of Service
  (https://cursor.com/terms-of-service).»
- ToS дают «limited right to access and use the Service» (1.1) — использование,
  не распространение.
- ToS 1.5 (iii) запрещают «rent, lease, lend, or sell the Service»; 1.5 (ii) —
  «reproduce, modify, translate, or create derivative works of the Service».
  Копирование пакета SDK в распространяемый образ — воспроизведение
  охраняемого материала; разрешающего пункта нет. Если читать «the Service»
  узко (только хостед-сервис), бинарники SDK остаются под обычным «All rights
  reserved» — разрешения на распространение нет ни при каком чтении.

Вывод: **перераспространение в публикуемом образе конфликтует с Cursor ToS
(reproduce / sell / rent / lease) либо, при узком чтении, просто не
лицензировано.** Разрешения в первичных текстах нет ни в одном варианте.

Источники: `package.json` и `LICENSE.md` tarball'а `@cursor/sdk@1.0.28` (npm,
анонимная загрузка); https://cursor.com/terms-of-service (1.1, 1.5).

### 3. `@img/sharp-libvips-*` 1.3.3 (LGPL-3.0-or-later)

- `package.json` tarball'а: `"license": "LGPL-3.0-or-later"`; пакет везёт
  прелинкованные динамические библиотеки (`libvips-cpp.so.8.18.6` и
  зависимости, версии перечислены в `versions.json`, напр. glib 2.89.4, pango
  1.58.2).
- LGPL-3.0 §4 (Combined Works) разрешает распространять составное произведение
  с библиотекой при условиях: библиотека остаётся под LGPL и заменяемой для
  пользователя — передать лицензию и копирайт библиотеки, указать источник,
  дать возможность заменить библиотеку модифицированной версией. sharp
  (Apache-2.0) грузит прелинкованный `.so` динамически; Myrmidon не меняет ни
  sharp, ни libvips.

Вывод: **распространять в составе образа можно, с обязательствами.** LGPL не
запрещает распространение и совместима с MIT-лицензией продукта; обязательства:
(a) уведомление с лицензией и копирайтом libvips и пакетированных библиотек
(README пакета перечисляет их, в том числе несколько под LGPLv3: fribidi, glib,
libexif, libheif, librsvg, pango, proxy-libintl) и (b) способ получить
соответствующий исходный код — практический путь: ссылка на точный upstream
(https://github.com/lovell/sharp-libvips, тег/версия 1.3.3) плюс
письменное предложение исходников по LGPL §6(d) (действует ≥ 3 лет).
Раскрытие исходников самого Myrmidon не требуется.

Источники: `package.json`, `versions.json` и `README` tarball'а
`@img/sharp-libvips-linux-x64@1.3.3` (npm, анонимная загрузка);
https://www.gnu.org/licenses/lgpl-3.0.html (§4, §6).

### 4. `@anthropic-ai/claude-code` 2.1.283 (глобальная npm-установка в образ)

- Ставится глобально в runtime-образ `Dockerfile'ом`
  (`ARG CLAUDE_CODE_VERSION=2.1.283`, `npm install --global --omit=dev`),
  поэтому едет в каждом публикуемом образе, но не попадает в `pnpm licenses
  list --prod` и отсутствует в `license-policy.json` — слепая зона CI-проверки
  лицензий.
- `LICENSE.md` tarball'а совпадает по сути с agent SDK: «© Anthropic PBC. All
  rights reserved. Use is subject to the Legal Agreements outlined here:
  https://code.claude.com/docs/en/legal-and-compliance»; `package.json`:
  `"license": "SEE LICENSE IN README.md"`.

Вывод: тот же проприетарный класс, что `@anthropic-ai/claude-agent-sdk`;
разрешения на распространение в первичных текстах нет. Любое решение по SDK
касается и его.

Источники: `package.json` и `LICENSE.md` tarball'а
`@anthropic-ai/claude-code@2.1.283` (npm, анонимная загрузка).

## Варианты

A. Оставить все четыре как есть.
   - Плюсы: работает из коробки (claude_local через SDK, cursor-cloud, быстрая
     обработка изображений, Claude Code CLI доступен агентам).
   - Минусы: проприетарные бинарники в публикуемом MIT-образе — юридический
     риск на владельце; ToS Cursor прямо называют sell/rent/lease/reproduce;
     образ тяжелеет на платформенные бинарники.

B. Вынести проприетарные SDK из базового образа в опциональный таргет/плагин
   (extra Docker target, плагин или документированный `pnpm add`/`npm i -g`
   пользователем); sharp/libvips оставить с LGPL-уведомлением.
   - Плюсы: базовый образ — только MIT и пермиссивные лицензии; условия
     Anthropic/Cursor ложатся на пользователя, ставящего SDK под свою учётную
     запись; прямой конфликт с ToS исчезает.
   - Минусы: нужен механизм в Dockerfile и документация; claude_local и
     cursor-cloud не работают, пока пользователь не подключит их;
     `@anthropic-ai/claude-code` (глобальная установка) требует того же
     решения либо осознанного оставления с уведомлением.

C. Не класть проприетарные SDK вообще; sharp/libvips оставить с уведомлением.
   Юридически чище всего; всё под OSI-лицензиями; пользователи ставят SDK/CLI
     в рантайме под свои учётные данные. Цена как у B плюс потеря
     предустановленного Claude Code CLI.

## Рекомендация

**B.** Вынести `@anthropic-ai/claude-agent-sdk` (с платформенными пакетами) и
`@cursor/sdk` (с `@cursor/sdk-linux-x64`) из базового образа в опциональный
таргет/плагин; `@anthropic-ai/claude-code` включить в то же решение (либо
вынести тоже, либо осознанно оставить с уведомлением). `@img/sharp-libvips-*`
оставить и добавить стороннее уведомление (лицензия, копирайт, ссылка на
исходники — LGPL §4). Это снимает единственный прямой конфликт с ToS (Cursor)
и неопределённость отсутствия grant'а (Anthropic), сохраняя легальный путь
самостоятельного подключения для тех, кому нужны эти адаптеры.

Если владелец выбирает A, минимальные обязательства: стороннее уведомление в
образе и/или репозитории по всем четырём пакетам (© Anthropic PBC — URL
Commercial Terms; © Anysphere Inc. — URL ToS; libvips LGPL-3.0-or-later со
ссылкой на исходники) и явное принятие того, что тексты Anthropic/Cursor
разрешения на перераспространение не дают.

Решение за владельцем; эта записка не меняет политику. Исключения в
`scripts/myrmidon/license-policy.json` остаются как есть до решения владельца.

## Источники

- `pnpm-lock.yaml` на `main` `a110c35de`: `@anthropic-ai/claude-agent-sdk@0.3.263`
  (prod через `@agentclientprotocol/claude-agent-acp`), `@cursor/sdk@1.0.28`
  (prod через `packages/adapters/cursor-cloud`), `@img/sharp-libvips-*@1.3.3`
  (необязательные платформенные зависимости `sharp`).
- `Dockerfile` на `main` `a110c35de`: `ARG CLAUDE_CODE_VERSION=2.1.283`,
  `npm install --global --omit=dev @anthropic-ai/claude-code@…`.
- Tarball'ы npm (registry.npmjs.org, анонимно): `package.json` / `LICENSE.md` /
  `README` пакетов `@anthropic-ai/claude-agent-sdk@0.3.263`, `@cursor/sdk@1.0.28`,
  `@img/sharp-libvips-linux-x64@1.3.3`, `@anthropic-ai/claude-code@2.1.283`.
- https://www.anthropic.com/legal/commercial-terms (A.1, D.4, F).
- https://cursor.com/terms-of-service (1.1, 1.5).
- https://code.claude.com/docs/en/legal-and-compliance.
- https://www.gnu.org/licenses/lgpl-3.0.html (§4 Combined Works, §6).
- `scripts/myrmidon/license-policy.json` (текущие исключения и пометки «на
  решение сопровождающего»).
