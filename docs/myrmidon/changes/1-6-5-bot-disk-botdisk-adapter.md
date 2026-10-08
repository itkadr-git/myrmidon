---
divergence-section: 1.6.1 — BOT-DISK B: общий кэш пакетов для контейнеров ботов
---

## changelog-en

### The hermes_gateway adapter sends the task workspace in the run request (1.6.5 BOT-DISK-H, part H5a)

- A run of a task that has a repository now carries a `workspace` field in the
  `POST /v1/runs` body: `{key, repo, baseRef}` — the issue identifier, the
  project's repository as `owner/name` and the workspace ref (omitted when the
  workspace has none). The gateway uses it to open the task copy before the
  model starts.
- A task without a repository, or without a board identifier, sends no field.
  A `workspace` written into the card's `payloadTemplate` is overwritten, like
  `github_broker`: a card cannot forge it.

## changelog-ru

### Адаптер hermes_gateway передаёт рабочую копию задачи в запросе прогона (1.6.5 BOT-DISK-H, часть H5a)

- Прогон задачи с репозиторием теперь несёт в теле `POST /v1/runs` поле
  `workspace`: `{key, repo, baseRef}` — идентификатор задачи, репозиторий
  проекта как `owner/name` и ссылка рабочего пространства (нет — поле `baseRef`
  опускается). По нему гейтвей открывает копию задачи до запуска модели.
- Задача без репозитория или без идентификатора доски поля не шлёт. Поле
  `workspace` из `payloadTemplate` карточки перезаписывается, как и
  `github_broker`: подделать его карточкой нельзя.

## divergence

| 1.6.5-BOT-DISK-H5a | Адаптер `hermes_gateway` добавляет в тело `/v1/runs` поле `workspace {key, repo, baseRef}` (контракт C6): ключ — идентификатор задачи, репозиторий — `owner/name` из `repoUrl` рабочего пространства прогона, `baseRef` — его `repoRef`; ставится после spread `payloadTemplate`, у задачи без репозитория поля нет | Наш файл `packages/adapters/hermes/src/gateway/server/execute.ts` (блок `myrmidon(1.6.5 BOT-DISK-H5a)`: `buildWorkspaceField`, `deriveWorkspaceRepoName`) и тест `execute.test.ts`. Маркеров вендора нет | Копия задачи создаётся при старте прогона самой доской, а не ботом, и не обходится им; дизайн эпика, раздел 2.2. Требование тикета OPE-5363 | `execute.test.ts`: поле по схеме и фикстуре C6, разные формы URL, отсутствие поля без репозитория или ключа, недопустимый baseRef, подделка через `payloadTemplate` | Никогда, наше поведение. Снятие: удалить блок `BOT-DISK-H5a` из `execute.ts`, тесты и этот фрагмент | (этот PR) |
