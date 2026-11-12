---
settings-section: 1.3 — STACK-UPDATES stack registry (SUA, parts A and B)
---

## changelog-en

### Stack watch live: self-refreshing local versions, GitHub 403 retry with stale marker, persistent update cards, owner escalation (1.6.7 STACK-WATCH-LIVE, OPE-12141)

- The scheduled stack release check now refreshes the local side itself: the http-version probe reads
  running versions from `MYRMIDON_STACK_HTTP_HINDSIGHT` (Hindsight `/version`), `MYRMIDON_STACK_HTTP_LITELLM`
  (LiteLLM `/version`) and `MYRMIDON_STACK_HTTP_LANGFUSE` (Langfuse `/api/public/health`), so a component
  no longer sits at «not refreshed yet» until a manual admin refresh.
- GitHub 403 (anonymous rate limit) is retried once after a configurable delay and otherwise recorded as
  stale: cards and the UI carry an explicit «сверка не удалась N ч, данные от ДАТЫ» marker instead of
  silently keeping the previous cache.
- A `stack_update` attention card now lives while the component is behind, not just one check, and lags or
  security notes escalate into backlog tasks (deduped per component) plus a line in the daily Telegram digest.
- The seeded registry reads only `myr-v*` release tags for the board component and no longer treats
  pre-release or nightly tags as the latest release; RAGFlow is marked as retired from the stack.

## changelog-ru

### Живая сверка стека: самообновляемые локальные версии, повтор при GitHub 403 с пометкой «устарело», живучие карточки обновлений, сигнал владельцу (1.6.7 STACK-WATCH-LIVE, OPE-12141)

- Плановая сверка релизов стека теперь сама обновляет локальную часть: http-зонд версий читает
  работающие версии из `MYRMIDON_STACK_HTTP_HINDSIGHT` (Hindsight `/version`), `MYRMIDON_STACK_HTTP_LITELLM`
  (LiteLLM `/version`) и `MYRMIDON_STACK_HTTP_LANGFUSE` (Langfuse `/api/public/health`), поэтому компонент
  больше не сидит на «not refreshed yet» до ручного обновления администратором.
- GitHub 403 (анонимный лимит) повторяется один раз после настраиваемой задержки, иначе фиксируется как
  устаревание: карточки и интерфейс несут явную пометку «сверка не удалась N ч, данные от ДАТЫ» вместо
  молчаливого удержания прежнего кэша.
- Карточка внимания `stack_update` живёт, пока компонент отстаёт, а не одну проверку; отставания и
  security-заметки эскалируются в задачи бэклога (дедуп по компоненту) и строку суточной сводки в Telegram.
- Сидированный реестр читает только релизные теги `myr-v*` для компонента доски и больше не считает
  пререлиз или nightly последним релизом; RAGFlow помечен как выведенный из стека.

## settings-en

| `MYRMIDON_STACK_HTTP_HINDSIGHT` | 1.6.7-STACK-WATCH-LIVE | unset | Base URL of the running Hindsight service the stack registry `http-version` local probe reads the running version from (one `GET <base>/version`, 5s timeout, JSON body with a `version` field) | Unset, empty or unreachable — the probe records an honest «unknown», never a check error |
| `MYRMIDON_STACK_HTTP_LITELLM` | 1.6.7-STACK-WATCH-LIVE | unset | Base URL of the running LiteLLM proxy the stack registry `http-version` local probe reads the running version from (one `GET <base>/version`, 5s timeout, JSON body with a `version` field) | Unset, empty or unreachable — honest «unknown», never a check error |
| `MYRMIDON_STACK_HTTP_LANGFUSE` | 1.6.7-STACK-WATCH-LIVE | unset | Base URL of the running Langfuse service the stack registry `http-version` local probe reads the running version from (one `GET <base>/api/public/health`, 5s timeout, JSON body with a `version` field) | Unset, empty or unreachable — honest «unknown», never a check error |

## settings-ru

| `MYRMIDON_STACK_HTTP_HINDSIGHT` | 1.6.7-STACK-WATCH-LIVE | не задана | Базовый URL работающего Hindsight, из которого http-зонд версий читает текущую версию (один `GET <base>/version`, таймаут 5 с, JSON с полем `version`) | Не задана, пустая или недоступна — честное «unknown», не ошибка сверки |
| `MYRMIDON_STACK_HTTP_LITELLM` | 1.6.7-STACK-WATCH-LIVE | не задана | Базовый URL работающего прокси LiteLLM для http-зонда версий (один `GET <base>/version`, таймаут 5 с, JSON с полем `version`) | Не задана, пустая или недоступна — честное «unknown», не ошибка сверки |
| `MYRMIDON_STACK_HTTP_LANGFUSE` | 1.6.7-STACK-WATCH-LIVE | не задана | Базовый URL работающего Langfuse для http-зонда версий (один `GET <base>/api/public/health`, таймаут 5 с, JSON с полем `version`) | Не задана, пустая или недоступна — честное «unknown», не ошибка сверки |
