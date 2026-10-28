---
divergence-section: 1.7 — GUARDRAILS: enforcement modes, settings UI, and firing journal
---

## changelog-en

### Guardrail enforcement modes, settings, and journal (1.7-GRD-MODES)

- Configurable enforcement modes (`flag`, `mask`, `block`) for all guardrail rule categories (`secret`, `pii`, `injection`).
- Precedence hierarchy: environment force override (`MYRMIDON_GUARDRAILS_FORCE_MODE_<RULE>`) > per-agent override > caste override > company setting > default `flag`.
- Effective resolution returns mode and resolution source (`env`, `agent`, `caste`, `company`, `default`).
- Hot configuration readback and persistence in `instance_settings.general.guardrailModes` without server restart.
- Run-output enforcement applies mode before visible publication; `block` safely withholds output and provides a safe refusal message with zero leakage.
- Queued-input injection protection enforces configured modes on queue updates, safely refusing injection when configured to block.
- Safety bounds preserved: 262,144-character scan bound, 20-event write cap, shape-redacted and clamped snippets.
- Settings screen in Company Settings → Guardrails (`/company/settings/guardrails`) with company, caste, and agent controls.
- Event firing journal with filtering by rule kind, severity, surface, and run ID.
- Complete English and Russian localization.

## changelog-ru

### Режимы применения ограждений, настройки и журнал (1.7-GRD-MODES)

- Настраиваемые режимы применения (`flag`, `mask`, `block`) для категорий правил (`secret`, `pii`, `injection`).
- Порядок разрешения: принудительное окружение (`MYRMIDON_GUARDRAILS_FORCE_MODE_<RULE>`) > индивидуальный агент > каста > компания > значение по умолчанию `flag`.
- Чтение эффективного режима возвращает действующий режим и его источник (`env`, `agent`, `caste`, `company`, `default`).
- Сохранение и горячее применение настроек в `instance_settings.general.guardrailModes` без перезапуска сервисов.
- Применение в выводе прогона до публикации; режим `block` безопасно скрывает ответ с публикацией стандартного отказа без раскрытия секретов.
- Защита очереди комментариев от инъекций с поддержкой блокировки при попытке инъекции.
- Сохранены безопасные ограничения: лимит сканирования 262 144 символа, лимит записи не более 20 событий, маскирование сниппетов.
- Экран настроек «Настройки компании → Ограждения» (`/company/settings/guardrails`) с управлением по компании, кастам и агентам.
- Журнал срабатываний с фильтрами по правилу, важности, точке проверки и ID прогона.
- Полная локализация интерфейса на русском и английском языках.
