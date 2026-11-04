---
settings-section: Track 3 — tool gateway and Hermes adapter
---

## changelog-en

### Central session history limits (MEMORY-CENTRAL-B)

- The card field `centralHistoryMaxTurns` defaults to 10 and is clamped to 1–50 turns.

## changelog-ru

### Ограничения центральной истории сессии (MEMORY-CENTRAL-B)

- Поле карточки `centralHistoryMaxTurns` по умолчанию равно 10; значение ограничивается диапазоном 1–50 ходов.

## settings-en

| `adapterConfig.centralHistoryMaxTurns` | MEMORY-CENTRAL-B | `10` | Maximum number of central session history turns restored into a Hermes gateway wake. The configured value is clamped to 1–50 | Whole number from 1 to 50; invalid or out-of-range values use the default |

## settings-ru

| `adapterConfig.centralHistoryMaxTurns` | MEMORY-CENTRAL-B | `10` | Максимальное число ходов центральной истории сессии, восстанавливаемых в побудку Hermes gateway. Значение ограничивается диапазоном 1–50 | Целое число от 1 до 50; неверное значение или значение вне диапазона заменяется умолчанием |
