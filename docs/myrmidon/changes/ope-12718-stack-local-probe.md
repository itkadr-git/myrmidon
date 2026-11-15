---
settings-section: 1.3 — STACK-UPDATES stack registry (SUA, parts A and B)
---

## changelog-en

### Stack registry: LiteLLM local version probe reads /public/model_hub/info (OPE-12718)

- LiteLLM has no `/version` route, so the http-version probe always answered
  "unreachable / 404" and the board showed no running version for the litellm
  component. The probe now targets LiteLLM's public model-hub endpoint
  `/public/model_hub/info` and reads the version from its `litellm_version`
  field; the generic `version` / `api_version` fields stay accepted as
  fallbacks. A bare base URL in `MYRMIDON_STACK_HTTP_LITELLM` is now enough —
  the documented endpoint is appended automatically, as for hindsight and
  Langfuse.

## changelog-ru

### Реестр стека: зонд версии LiteLLM читает /public/model_hub/info (OPE-12718)

- У LiteLLM нет маршрута `/version`, поэтому http-зонд версии всегда отвечал
  «unreachable / 404», и на доске не было рабочей версии компонента litellm.
  Зонд теперь обращается к публичному эндпоинту model-hub LiteLLM
  `/public/model_hub/info` и берёт версию из поля `litellm_version`; общие
  поля `version` / `api_version` остаются принятыми как запасные. Для
  `MYRMIDON_STACK_HTTP_LITELLM` теперь достаточно голого базового адреса —
  документированный эндпоинт дописывается автоматически, как для hindsight и
  Langfuse.

## settings-en

| `MYRMIDON_STACK_HTTP_LITELLM` | OPE-12718 | unset | Base URL of the LiteLLM proxy for the local version probe; the probe GETs `<base>/public/model_hub/info` (5s timeout, JSON body with a `litellm_version` field) | Unset, empty or unreachable — honest «unknown», never a check error |

## settings-ru

| `MYRMIDON_STACK_HTTP_LITELLM` | OPE-12718 | не задана | Базовый URL работающего прокси LiteLLM для http-зонда версий (один `GET <base>/public/model_hub/info`, таймаут 5 с, JSON с полем `litellm_version`) | Не задана, пустая или недоступна — честное «unknown», не ошибка сверки |
