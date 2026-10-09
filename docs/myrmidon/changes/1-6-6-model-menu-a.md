## changelog-en

### Model menu: the group tree of `/model` and the rules that build it (1.6.6-MODEL-MENU A)

- The bot's model list stops being a flat wall of buttons: `/model` becomes a
  menu of groups, and the owner decides in the board which models are visible,
  how they are grouped and how deep the nesting goes (the owner's decision of
  10.10, following the flat list of 1.6.5).
- Part A — the menu model itself. `@paperclipai/shared` (`myrmidon-model-menu.ts`)
  carries the canonical shape of `instance_settings.general.modelMenu`: a tree
  of groups of any depth (title, models, nested groups) plus the list of hidden
  models, validated as a whole (a hand-edited row that does not match is
  ignored entirely), at most 8 levels deep.
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
  subgroups and models, the
  last row is `Назад` while the position is not the root, and a level longer
  than `MODEL_MENU_PAGE_SIZE` (20) is paged with `Ещё →`, never past Telegram's
  limit of 100 buttons per message. The transport is not in this part: the
  entries are `{ kind, label }` plus the position they lead to.
- The settings API, the web editor and the inline buttons of the bot land in
  the following parts (the button transport is the 1.6.5 F-07 work).

## changelog-ru

### Меню моделей: дерево групп `/model` и правила, по которым оно строится (1.6.6-MODEL-MENU A)

- Список моделей бота перестаёт быть плоской стеной кнопок: `/model`
  становится меню групп, а владелец сам решает на доске, какие модели видны,
  как они сгруппированы и на сколько уровней вложены (решение владельца от
  10.10, вслед за плоским списком 1.6.5).
- Часть A — сама модель меню. В `@paperclipai/shared`
  (`myrmidon-model-menu.ts`) лежит канонический вид
  `instance_settings.general.modelMenu`: дерево групп произвольной глубины
  (название, модели, вложенные группы) и список скрытых моделей. Строка
  проверяется целиком — правленое руками значение, не проходящее проверку,
  игнорируется полностью; глубина ограничена 8 уровнями.
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
- API настроек, редактор в вебе и кнопки бота — следующие части (транспорт
  кнопок — это работа 1.6.5 F-07).