---
divergence-section: Трек 1 — платформа
---

## changelog-en

### Add the built-in instance administrator (ADMIN-ASSISTANT)

- Register the instance administrator as a first-class built-in agent and route routine or complex work through configured LiteLLM models with reserve fallback.

## changelog-ru

### Добавлен встроенный агент-администратор инстанса (ADMIN-ASSISTANT)

- Встроенный администратор инстанса зарегистрирован как отдельный агент; рутинные и сложные задачи маршрутизируются через настроенные модели LiteLLM с резервным переключением.

## divergence

| ADMIN-ASSISTANT | Встроенный агент-администратор и маршрутизатор моделей | `server/src/services/built-in-agents.ts` + `server/src/myrmidon/admin-assistant/*` + тесты | OPE-8662: отдельная роль администратора с дешёвой/старшей моделью и резервом через LiteLLM | `server/src/myrmidon/admin-assistant/router.myrmidon.test.ts`, `server/src/__tests__/built-in-agents.test.ts` | Никогда, поведение Myrmidon. Снять только при переносе встроенной роли и маршрутизации вендором | (этот PR) |

## settings-en-new

### Instance administrator

The `admin-assistant` built-in agent is provisioned as the instance administrator and uses the existing gateway adapter. Its owner-provided model routing is read from `adapterConfig.adminAssistant.routing` (`routineModel`, `complexModel`, and optional `reserveModel`), with effective values and their source shown in settings. Values must be model IDs exposed by the connected LiteLLM catalog; changes apply to the next task without a restart. Routine tasks use the cheap model, complex tasks use the senior model, and an unavailable preferred model falls back to the reserve.

## settings-ru-new

### Агент-администратор инстанса

Встроенный агент `admin-assistant` регистрируется как администратор инстанса и использует существующий gateway-адаптер. Маршрутизация владельца берётся из `adapterConfig.adminAssistant.routing` (`routineModel`, `complexModel` и необязательный `reserveModel`); экран настроек показывает эффективные значения и их источник. Значения должны быть идентификаторами моделей из подключённого каталога LiteLLM; изменения применяются на следующей задаче без перезапуска. Рутинные задачи идут на дешёвую модель, сложные — на старшую, а недоступная предпочтительная модель заменяется резервной.
