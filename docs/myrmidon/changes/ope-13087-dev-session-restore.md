## changelog-en

### Developers continue the task session between runs (1.6.9 DEV-SESSION-RESTORE, OPE-13087)

- Developer agents (engineers and code reviewers) now keep the session strategy set on their card (`issue`, `run` or `none`) instead of being forced to a fresh session on every run; an agent-wide (`agent`) or empty strategy becomes `issue`, so a developer never gets an agent-wide session.
- Design notes and code comments now state the rule correctly: developers get no long-term memory, while the task session continues between runs.

## changelog-ru

### Разработчики продолжают сеанс задачи между прогонами (1.6.9 DEV-SESSION-RESTORE, OPE-13087)

- Разработчики (инженеры и ревьюеры кода) теперь получают стратегию сеанса из карточки (`issue`, `run` или `none`), а не принудительно новый сеанс на каждый прогон. Стратегия на всего агента (`agent`) или пустая заменяется на `issue`: сеанса на всего агента у разработчика не бывает.
- Документ дизайна и комментарии в коде исправлены: у разработчиков нет долговременной памяти, сеанс задачи между прогонами продолжается.
