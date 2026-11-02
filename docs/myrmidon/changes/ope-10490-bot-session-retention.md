---
settings-section: Track 3 — tool gateway and Hermes adapter
---

## settings-en

| `MYRMIDON_BOTD_SESSION_RETENTION_DAYS` | OPE-10490 | `30` | After the Hermes gateway health endpoint responds, session retention runs in the background. Sessions with numeric `last_active` older than this many days are selected, excluding rows marked `pinned` or `is_active`. Each session detail is streamed to an archive manifest before a `DELETE /api/sessions/{id}` request; a failed export prevents deletion. No VACUUM/optimize runs on the live database | Unset or invalid — 30 days |
| `MYRMIDON_BOTD_SESSION_DELETE_PAUSE_SEC` | OPE-10490 | `1` | Delay in seconds after each sequential retention deletion attempt | Unset or invalid — 1 second |
| `MYRMIDON_BOTD_SESSION_HEALTH_WAIT_SEC` | OPE-10490 | `180` | Maximum seconds the background task waits for gateway `/health`; on timeout, retention is skipped for this startup | Unset — 180 seconds |

## settings-ru-append

<!-- section: Трек 3 — шлюз инструментов и адаптер Hermes -->

| `MYRMIDON_BOTD_SESSION_RETENTION_DAYS` | OPE-10490 | `30` | После ответа health-endpoint шлюза Hermes контейнерный runtime запускает очистку в фоне. Выбираются строки с числовым `last_active` старше указанного числа дней, кроме отмеченных `pinned` или `is_active`. Детали каждой сессии потоково записываются в архивный manifest до запроса `DELETE /api/sessions/{id}`; при ошибке экспорта удаление не выполняется. VACUUM/optimize работающей базы не запускается | Не задана или неверна — 30 дней |
| `MYRMIDON_BOTD_SESSION_DELETE_PAUSE_SEC` | OPE-10490 | `1` | Пауза в секундах после каждой попытки последовательного удаления сессии | Не задана или неверна — 1 секунда |
| `MYRMIDON_BOTD_SESSION_HEALTH_WAIT_SEC` | OPE-10490 | `180` | Максимум секунд ожидания `/health` шлюза фоновой задачей; по тайм-ауту очистка при этом запуске пропускается | Не задана — 180 секунд |
