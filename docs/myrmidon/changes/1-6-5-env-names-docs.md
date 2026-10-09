---
settings-section: Track 2 — wake and run core
---

## settings-en

| `MYRMIDON_CONTINUATION_MESSAGE_CHARS` | P3 / DB-CARE DBC-3 | `32000` | Character budget of the message list a run resumes from, measured on the stored form (the JSON of every message). Once it is exceeded the oldest non-pinned bodies turn into references first, then those referenced messages are dropped, and only then are the remaining bodies shortened to `MYRMIDON_CONTINUATION_MESSAGE_BODY_CHARS`. Pinned for good: the ids in `originCommentIds` plus the first and the last user request | `0` — the budget is off; non-numeric or negative — the default |
| `MYRMIDON_CONTINUATION_MESSAGE_BODY_CHARS` | P3 / DB-CARE DBC-3 | `8000` | Per-body budget applied to the bodies that survive the total budget above: the cut is deterministic and the appended marker spells out how many characters were omitted, so a body capped in one run compares equal to the same body capped in the next one and never re-enters the resume delta | `0` — the per-body cut is off; non-numeric or negative — the default |

## settings-ru

| `MYRMIDON_CONTINUATION_MESSAGE_CHARS` | P3 / DB-CARE DBC-3 | `32000` | Бюджет символов списка сообщений, с которого продолжается прогон; считается по хранимой форме (JSON каждого сообщения). При превышении сначала тела самых старых незакреплённых сообщений становятся ссылками, затем эти сообщения отбрасываются, и лишь потом оставшиеся тела урезаются до `MYRMIDON_CONTINUATION_MESSAGE_BODY_CHARS`. Закреплены всегда: id из `originCommentIds` и первый с последним запрос пользователя | `0` — бюджет выключен; нечисловое или отрицательное — по умолчанию |
| `MYRMIDON_CONTINUATION_MESSAGE_BODY_CHARS` | P3 / DB-CARE DBC-3 | `8000` | Бюджет на тело сообщения для тех тел, что пережили общий бюджет выше: срез детерминированный, а добавленный маркер прямо называет число опущенных символов, поэтому тело, урезанное в одном прогоне, сравнимо равным с тем же телом, урезанным в следующем, и не возвращается в дельту продолжения | `0` — срез тел выключен; нечисловое или отрицательное — по умолчанию |

## settings-en-append

<!-- section: BOT-DISK E — host disk usage signal -->
<!-- occurrence: 1 -->
| `MYRMIDON_BOT_SCOPE_SUBDIR` | BOT-DISK-F | written by the board into the container's `Env` (the bot's own key) | Name of the member bot's directory inside the scope instance's `/bot-scope`: the entrypoint points the links (`/workspace`, `/scratch`, `<HERMES_HOME>`, the store) into `/bot-scope/<this name>/`, so every member of a shared scope writes only inside its own subdirectory. The only `Env` dockergate ever accepts ([dockergate.md](dockergate.md)); a value with `/`, `.`, `..` or a leading `-` is refused at start. The host-side root is `MYRMIDON_BOT_SCOPE_ROOT`; full guide — [bot-disk-cache.md](bot-disk-cache.md) | Not set by hand: the driver passes the bot's own key; unset — the bot works with its own mounts, not a shared scope |

## settings-ru-append

<!-- section: BOT-DISK E — host disk usage signal -->
<!-- occurrence: 1 -->
| `MYRMIDON_BOT_SCOPE_SUBDIR` | BOT-DISK-F | пишет доска в `Env` контейнера (собственный ключ бота) | Имя каталога бота-участника внутри `/bot-scope` экземпляра области: entrypoint направляет ссылки (`/workspace`, `/scratch`, `<HERMES_HOME>`, склад) в `/bot-scope/<это имя>/`, поэтому каждый участник общей области пишет только в свой подкаталог. Единственный `Env`, который вообще принимает dockergate ([dockergate.md](dockergate.md)); значение с `/`, `.`, `..` или ведущим `-` отвергается на старте. Корень на стороне хоста — `MYRMIDON_BOT_SCOPE_ROOT`; полное руководство — [bot-disk-cache.md](bot-disk-cache.md) | Руками не задаётся: драйвер передаёт собственный ключ бота; не задано — бот работает со своими монтированиями, без общей области |