---
divergence-section: Трек 1 — платформа
---

## changelog-en

### GitHub broker explains "no repository" instead of looking like "no access"

- Run engineers saw `gh auth status` or `gh api user` fail as unauthenticated when run outside
  a clone and concluded they had no GitHub access, although the broker issues tokens normally.
  The broker only mints a token once the target `owner/repo` is known, and otherwise answered a
  bare `absent`.
- The broker now infers the repository from the task: its own workspace, then the project's
  primary workspace (a single distinct github.com repository). If none is known it still
  answers `absent`, now with `reasonCode: "repository_required"` and `availableRepositories`,
  the repository patterns of the PAT and App entries that serve the calling agent (at most 50;
  configuration only, never secrets). Nothing is minted or read from the secret store without a
  repository.
- The `gh` wrapper in the bot image also takes the repository from the `repos/OWNER/REPO`
  endpoint of `gh api`, says in plain words "GitHub access is available, pass -R owner/repo,
  set GH_REPO or work inside a clone" (with the allowed repositories), explains a plain `absent`,
  and `gh auth status` reports the broker's state (identity, repository, never the token)
  instead of "not logged in".

## changelog-ru

### Брокер GitHub объясняет «репозиторий не указан», а не выглядит как «доступа нет»

- Инженеры прогонов видели, что `gh auth status` или `gh api user` вне клона отвечают
  «unauthenticated», и решали, что доступа к GitHub нет, хотя брокер выдаёт токены штатно.
  Брокер выпускает токен только когда известен `owner/repo`, а иначе отвечал голым `absent`.
- Теперь брокер выводит репозиторий из задачи: рабочая область самой задачи, затем основная
  рабочая область проекта (один уникальный репозиторий github.com). Если репозиторий неизвестен,
  ответ по-прежнему `absent`, но с `reasonCode: "repository_required"` и `availableRepositories`,
  списком шаблонов репозиториев из записей PAT и App, доступных вызывающему агенту (не более 50;
  только конфигурация, без секретов). Без репозитория токен не выпускается и хранилище секретов
  не читается.
- Обёртка `gh` в образе ботов теперь берёт репозиторий и из эндпоинта `repos/OWNER/REPO` у
  `gh api`, прямо пишет «доступ к GitHub есть, укажите -R owner/repo, задайте GH_REPO или
  работайте внутри клона» (со списком допустимых репозиториев), объясняет обычный `absent`, а
  `gh auth status` показывает состояние брокера (личность, репозиторий, без токена) вместо
  «not logged in».
