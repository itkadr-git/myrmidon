---
settings-section: Track 5 — operations
---

## changelog-en

### KNOWLEDGE: lesson distillation settings moved to Fine settings (OPE-12628)

- Sweep settings `lessonDistillEnabled`, `lessonDistillWindowHours`, `lessonDistillRepeatThreshold`, and `lessonDistillPeriodMinutes` exposed in "Fine settings" (system section).
- Resolution honors explicit environment variable, then saved UI setting, then default.
- Enabled toggle, window hours, and repeat threshold are evaluated per tick without restart; period is read at process startup (fixed timer interval).

## changelog-ru

### ЗНАНИЯ: параметры извлечения уроков перенесены в «Тонкие настройки» (OPE-12628)

- Параметры обхода `lessonDistillEnabled`, `lessonDistillWindowHours`, `lessonDistillRepeatThreshold` и `lessonDistillPeriodMinutes` вынесены в «Тонкие настройки» (раздел system).
- Разрешение каждого параметра: явная переменная окружения, затем сохранённая настройка из UI, затем умолчание.
- Флаг включения, окно и порог повторов читаются на каждом тике без перезапуска; период читается при старте процесса (фиксированный интервал таймера).

## settings-en

| `MYRMIDON_LESSON_DISTILL_ENABLED` | 1.7 | `off` | Enable lesson distillation with 1 | Behavioral override: UI (1.7); env takes precedence. Evaluated on each tick without restart |
| `MYRMIDON_LESSON_DISTILL_PERIOD_MINUTES` | 1.7 | `60` | Lesson distillation sweep interval (minutes) | Behavioral override: UI (1.7); env takes precedence. Fixed timer interval read at process startup |
| `MYRMIDON_LESSON_DISTILL_REPEAT_THRESHOLD` | 1.7 | `2` | Minimum repetitions for lesson distillation | Behavioral override: UI (1.7); env takes precedence. Evaluated on each tick without restart |
| `MYRMIDON_LESSON_DISTILL_WINDOW_HOURS` | 1.7 | `24` | Lesson distillation lookback window (hours) | Behavioral override: UI (1.7); env takes precedence. Evaluated on each tick without restart |

## settings-ru

| `MYRMIDON_LESSON_DISTILL_ENABLED` | 1.7 | `off` | Включает извлечение уроков при значении 1 | Поведенческая настройка: в UI (1.7); env имеет приоритет. Читается на каждом тике без перезапуска |
| `MYRMIDON_LESSON_DISTILL_PERIOD_MINUTES` | 1.7 | `60` | Период извлечения уроков (минуты) | Поведенческая настройка: в UI (1.7); env имеет приоритет. Фиксированный интервал таймера при старте процесса |
| `MYRMIDON_LESSON_DISTILL_REPEAT_THRESHOLD` | 1.7 | `2` | Минимальное число повторений для извлечения урока | Поведенческая настройка: в UI (1.7); env имеет приоритет. Читается на каждом тике без перезапуска |
| `MYRMIDON_LESSON_DISTILL_WINDOW_HOURS` | 1.7 | `24` | Окно извлечения уроков (часы) | Поведенческая настройка: в UI (1.7); env имеет приоритет. Читается на каждом тике без перезапуска |
