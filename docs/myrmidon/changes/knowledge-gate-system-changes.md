---
settings-section: Track 5 — operations
---

## changelog-en

### Knowledge-note gate for system changes

- System-significant issue changes now require a valid `Вики: slug@rev` reference when moving to `done` or approving review.
- The gate is warning-only for the first three days after 2026-10-31, then returns `knowledge_note_required` when the reference is absent or invalid.

## changelog-ru

### Гейт записи вики для системно значимых изменений

- Для системно значимых изменений при переводе задачи в `done` или одобрении ревью требуется действительная ссылка `Вики: slug@rev`.
- Первые три дня после 2026-10-31 действует только предупреждение; затем без действительной ссылки возвращается `knowledge_note_required`.

## settings-en

| `MYRMIDON_KNOWLEDGE_GATE_MODE` | KNOWLEDGE-GATE | automatic rollout | Override the knowledge-note gate mode; `warning` permits transitions with a warning and `enforce` rejects missing or invalid references | Unset uses the date-based rollout |
| `MYRMIDON_KNOWLEDGE_GATE_START_DATE` | KNOWLEDGE-GATE | `2026-10-31` | Override the rollout anchor date used to switch from warning-only to enforcement | Unset uses the built-in rollout date |

## settings-ru

| `MYRMIDON_KNOWLEDGE_GATE_MODE` | KNOWLEDGE-GATE | автоматический rollout | Переопределяет режим гейта записи вики: `warning` разрешает переход с предупреждением, `enforce` отклоняет отсутствующие или недействительные ссылки | Без значения используется rollout по дате |
| `MYRMIDON_KNOWLEDGE_GATE_START_DATE` | KNOWLEDGE-GATE | `2026-10-31` | Переопределяет дату перехода от предупреждений к обязательной проверке | Без значения используется встроенная дата rollout |
