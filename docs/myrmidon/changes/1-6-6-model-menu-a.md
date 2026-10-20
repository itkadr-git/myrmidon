## changelog-en

### Model menu: the group tree of `/model`, the rules that build it and the owner's editor (1.6.6-MODEL-MENU A+B)

- The bot's model list stops being a flat wall of buttons: `/model` becomes a
  menu of groups, and the owner decides in the board which models are visible,
  how they are grouped and how deep the nesting goes (the owner's decision of
  10.10, following the flat list of 1.6.5).
- Part A — the menu model itself. `@paperclipai/shared` (`myrmidon-model-menu.ts`)
  carries the canonical shape of `instance_settings.general.modelMenu`: a tree
  of groups of any depth (title, models, nested groups) plus the list of hidden
  models, validated as a whole (a hand-edited row that does not match is
  ignored entirely — the automatic menu is shown rather than half a tree), at
  most 8 levels deep.
- With no tree stored the menu is built automatically: one group per
  provider/family of the gateway catalog, DashScope first, then z.ai, then the
  rest alphabetically (`Прочие` for what matches no family), so the 1.6.5 order
  survives without any settings.
- A catalog model the tree does not mention is never lost: it lands in the
  `Новые` group. A model the tree names but the catalog does not offer is
  dropped and reported (`missingModelIds`), a model named twice is kept once at
  its first position, and the invariant `visible = catalog − hidden` holds.
- The screens of the menu
  (`server/src/myrmidon/agent-chat-bridge/model-menu.ts`) are built from the
  resolved tree: the first screen is the first level, a group opens into its
  subgroups and models, the last row is `Назад` while the position is not the
  root, and a level longer than `MODEL_MENU_PAGE_SIZE` (20) is paged with
  `Ещё →`, never past Telegram's limit of 100 buttons per message. The
  transport is not in this part: the entries are `{ kind, label }` plus the
  position they lead to.
- Part B — the setting and its editor. `GET /api/myrmidon/model-menu` (any
  board member) reports the menu in force: the stored tree, the catalog it was
  resolved against and the groups the bot would show;
  `PATCH /api/myrmidon/model-menu` (instance admin) saves the tree and the
  hidden list, keeps the keys a patch leaves out, refuses a tree past the
  depth/width/model-count limits (`400 model_menu_tree_too_large`) and writes
  one activity-log line (`instance.model_menu.updated`, with the changed keys).
  The row lives in `instance_settings.general.modelMenu`, and a hand-edited
  value that does not validate reads as absent, so it can never wipe the other
  general settings.
- Instance → General («Model menu») is the editor: the catalog selector, a list
  editor for the group tree — rename, reorder, nest, add a group of models from
  the catalog, delete — and the hidden models, with the menu the bot would show
  drawn under the editor. Saving writes the same row the bot reads, so a change
  applies without a restart.
- The inline buttons of the bot land in the following part (the button
  transport is the 1.6.5 F-07 work).

## changelog-ru

### Меню моделей: дерево групп `/model`, правила, по которым оно строится, и редактор владельца (1.6.6-MODEL-MENU A+B)

- Список моделей бота перестаёт быть плоской стеной кнопок: `/model`
  становится меню групп, а владелец сам решает на доске, какие модели видны,
  как они сгруппированы и на сколько уровней вложены (решение владельца от
  10.10, вслед за плоским списком 1.6.5).
- Часть A — сама модель меню. В `@paperclipai/shared`
  (`myrmidon-model-menu.ts`) лежит канонический вид
  `instance_settings.general.modelMenu`: дерево групп произвольной глубины
  (название, модели, вложенные группы) и список скрытых моделей. Строка
  проверяется целиком — правленое руками значение, не проходящее проверку,
  игнорируется полностью (показывается автоматическое меню, а не половина
  дерева); глубина ограничена 8 уровнями.
- Пока дерево не задано, меню строится автоматически: по группе на
  провайдера/семейство каталога шлюза, DashScope первым, затем z.ai, дальше по
  алфавиту (`Прочие` для того, что не опознано) — порядок 1.6.5 сохраняется без
  всяких настроек.
- Модель каталога, которую дерево не назвало, не теряется: она попадает в
  группу «Новые». Модель, названная деревом, но отсутствующая в каталоге,
  отбрасывается и попадает в отчёт (`missingModelIds`); названная дважды
  остаётся один раз, на первом месте; выполняется равенство
  «видимые = каталог − скрытые».
- Экраны меню (`server/src/myrmidon/agent-chat-bridge/model-menu.ts`) строятся
  из разрешённого дерева: первый экран — группы первого уровня, группа
  раскрывается в свои подгруппы и модели, последней строкой идёт «Назад», пока
  позиция не корень, а уровень длиннее `MODEL_MENU_PAGE_SIZE` (20) листается
  «Ещё →» и никогда не выходит за предел Telegram в 100 кнопок на сообщение.
  Транспорта в этой части нет: запись — это `{ kind, label }` и позиция, куда
  она ведёт.
- Часть B — настройка и её редактор. `GET /api/myrmidon/model-menu` (любой
  участник доски) отдаёт меню в силе: сохранённое дерево, каталог, по которому
  оно разрешено, и группы, которые показал бы бот; `PATCH
  /api/myrmidon/model-menu` (администратор экземпляра) сохраняет дерево и список
  скрытых, оставляет ключи, которых в запросе нет, отказывает дереву за
  пределами глубины/ширины/числа моделей (`400 model_menu_tree_too_large`) и
  пишет одну строку журнала действий (`instance.model_menu.updated` с
  изменившимися ключами). Строка живёт в
  `instance_settings.general.modelMenu`; правленое руками значение, не
  проходящее проверку, читается как отсутствующее и не может стереть остальные
  общие настройки.
- Instance → General («Model menu») — редактор: выбор каталога, редактор дерева
  списками (переименовать, изменить порядок, вложить, добавить группу моделей
  каталога, удалить) и скрытые модели, а под редактором нарисовано меню,
  которое показал бы бот. Сохранение пишет ту же строку, которую читает бот,
  поэтому изменение действует без перезапуска.
- Кнопки бота в Telegram — следующая часть (транспорт кнопок — это работа
  1.6.5 F-07).

## settings-en-new

### 1.6.6 — MODEL-MENU B: grouped /model menu

Not an environment variable: an instance setting, `instance_settings.general.modelMenu`,
changed on Instance → General («Model menu») or through `GET`/`PATCH
/api/myrmidon/model-menu` (GET is any board member, PATCH is instance-admin
only). The stored value is a tree of groups of arbitrary depth — a group carries
a title, the models it names from the gateway catalog and its own nested groups —
plus the list of hidden models. Absent, the menu groups by provider family
automatically (the 1.6.5 order: DashScope, z.ai, then the rest); a catalog model
the tree does not name lands in «Новые» and is not lost; visible = catalog minus
hidden. It applies without a restart: `/model` reads the row on every command. A
row that does not validate is ignored as a whole — the automatic menu is shown
rather than half a tree.

## settings-ru-new

### 1.6.6 — MODEL-MENU B: меню /model группами

Не переменная окружения, а настройка экземпляра —
`instance_settings.general.modelMenu`: меняется на Instance → General («Model
menu») или через `GET`/`PATCH /api/myrmidon/model-menu` (GET — любой участник
доски, PATCH — только администратор экземпляра). Хранимое значение — дерево
групп произвольной глубины (название группы, модели каталога шлюза, вложенные
группы) и список скрытых моделей. Пока дерева нет, меню группируется по
семейству провайдера автоматически (порядок 1.6.5: DashScope, z.ai, затем
остальные); модель каталога, которую дерево не назвало, попадает в группу
«Новые» и не теряется; видимые = каталог минус скрытые. Действует без
перезапуска: `/model` читает строку на каждой команде. Строка, не проходящая
проверку, игнорируется целиком — показывается автоматическое меню, а не
половина дерева.