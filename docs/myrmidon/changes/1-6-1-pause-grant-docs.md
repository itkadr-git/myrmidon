## changelog-en

### Agent pause by grant (ADMIN-AGENT D)

- `POST /agents/:id/pause` now authorizes agent actors through the same
  direct-grant ladder as resume: an agent holding `agents:configure` may
  pause an agent of its company, while `agents:suggest-changes` and
  ungranted peers stay denied. Board actors keep the previous semantics
  unchanged, and the pause activity entry now records the real acting
  principal (agent, run, API key) instead of a board placeholder.
  Drain-vs-cancel semantics are untouched.

## changelog-ru

### Пауза агента по гранту (ADMIN-AGENT D)

- `POST /agents/:id/pause` теперь авторизует агентских актёров через ту же
  лесенку прямых грантов, что и resume: агент с `agents:configure` может
  ставить на паузу агента своей компании, а `agents:suggest-changes` и
  актёры без гранта остаются в отказе. Досковые актёры работают как раньше,
  а запись о паузе в журнале активности теперь несёт настоящего инициатора
  (агент, прогон, API-ключ) вместо заглушки доски. Семантика
  «доработать/отменить» (pause-drain) не менялась.
