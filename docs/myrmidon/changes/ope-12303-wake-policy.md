## settings-en-replace

| `runtimeConfig.heartbeat.maxDailyRuns` | 1.6.6-SETTINGS-UI-B | unset (no cap) | Maximum heartbeat runs per UTC day for one agent; the card's Run Policy section edits it (0 = no limit, stored as absent). The engine also reads the legacy aliases `dailyRunLimit` / `dailyRunCap` / `maxRunsPerDay`; over the cap a wake is skipped with reason `heartbeat.daily_run_limit`, except for the bounded pending-card bypass described in this section | Absent or `null` — no cap |

## settings-en-append

<!-- section: Settings in the agent record (not environment variables) -->
| `runtimeConfig.heartbeat.maxDailyInteractionWakes` | 1.6.9 | `50` | Maximum `interaction_pending` wakes per agent per UTC day allowed through the daily run limit while their card remains pending and addressed to that agent. The daily cost limit still applies | `0` disables this bypass; finite non-negative numbers are rounded down, invalid values use the default |

## settings-ru-replace

| `runtimeConfig.heartbeat.maxDailyRuns` | 1.6.6-SETTINGS-UI-B | нет (без лимита) | Максимум прогонов побуждений в сутки (UTC) для агента; редактируется в секции Run Policy карточки (0 = без лимита, хранится как отсутствие). Движок также читает алиасы `dailyRunLimit` / `dailyRunCap` / `maxRunsPerDay`; при превышении побудка пропускается с причиной `heartbeat.daily_run_limit`, кроме ограниченного обхода для ожидающих карточек, описанного в этом разделе | Отсутствие или `null` — без лимита |

## settings-ru-append

<!-- section: Настройки в записи агента (не переменные окружения) -->
| `runtimeConfig.heartbeat.maxDailyInteractionWakes` | 1.6.9 | `50` | Максимум побудок `interaction_pending` на агента за сутки UTC, проходящих мимо суточного лимита прогонов, пока карточка ожидает ответа и адресована этому агенту. Суточный лимит расходов продолжает действовать | `0` отключает обход; конечные неотрицательные числа округляются вниз, некорректные значения заменяются значением по умолчанию |
