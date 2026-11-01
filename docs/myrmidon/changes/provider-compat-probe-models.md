---
divergence-section: Трек 1 — платформа
---

## changelog-en

### Provider tool-call compatibility probe uses a model the provider really lists

- The probe no longer assumes `gpt-4o-mini`: it takes the first model from the provider's
  `/models` answer (or an explicit probe model). A provider with an empty model list gets a
  clear "provider_no_models" error instead of a false pass or a 404 for a missing model.
- The stored and returned `toolCallCheckError` is now a short `code: description`
  (`provider_http_<status>`, `no_tool_call`, `provider_unreachable`, `probe_failed`); the raw
  exception text, provider response body and headers are never kept or logged.

## changelog-ru

### Проба совместимости провайдера берёт модель, которую провайдер реально отдаёт

- Проба больше не опирается на `gpt-4o-mini`: берётся первая модель из ответа `/models`
  провайдера (или явно заданная модель пробы). Если список моделей пуст, возвращается понятная
  ошибка `provider_no_models`, а не ложный успех или 404 по несуществующей модели.
- `toolCallCheckError` в хранилище и ответе API теперь короткий `код: описание`
  (`provider_http_<статус>`, `no_tool_call`, `provider_unreachable`, `probe_failed`); сырой текст
  исключения, тело ответа провайдера и заголовки не сохраняются и не логируются.
