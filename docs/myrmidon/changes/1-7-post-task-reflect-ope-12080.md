---
issue: OPE-12080
roadmap: Д16/NEW POST-TASK-REFLECT
module: server/src/myrmidon/hindsight/reflection/
---

## changelog-en

### POST-TASK-REFLECT: lesson format and hindsight reflection domain (OPE-12080)

- Implemented `server/src/myrmidon/hindsight/reflection/` (with re-export at `server/src/myrmidon/reflection/`):
  - Types: `LessonRecord`, `FailureKind` (`review_changes` | `error` | `blocked`), `CreateLessonRecordInput`, `HindsightRetainPayload`.
  - Schema: Zod schemas for input, lesson record, and hindsight retain payload with strict pre-send validation (`validateHindsightRetainPayload`).
  - Lesson formatter: template lesson text, role bank address format (`role-<companyId>-<role>`), issue document id anchor, and deterministic dedup key.
  - Service: failure categorization (`review_changes`, `error`, `blocked`), lesson record creation with default 30-day expiry (`expires_at_days = 30`), and safe submission.
  - Comprehensive unit tests in `reflection.myrmidon.test.ts`.

## changelog-ru

### POST-TASK-REFLECT: формат урока и домен hindsight-рефлексии (OPE-12080)

- Реализован домен `server/src/myrmidon/hindsight/reflection/` (и реэкспорт в `server/src/myrmidon/reflection/`):
  - Типы: `LessonRecord`, `FailureKind` (`review_changes` | `error` | `blocked`), `CreateLessonRecordInput`, `HindsightRetainPayload`.
  - Схема: Zod-схемы для входных данных, записи урока и полезной нагрузки hindsight с валидацией перед отправкой (`validateHindsightRetainPayload`).
  - Форматтер уроков: шаблонный текст урока, адресация банка роли (`role-<companyId>-<role>`), привязка document id к задаче и детерминированный ключ дедупликации.
  - Сервис: категоризация сбоев (`review_changes`, `error`, `blocked`), создание записи со сроком годности 30 дней по умолчанию (`expires_at_days = 30`) и безопасная отправка.
  - Модульные тесты в `reflection.myrmidon.test.ts`.
