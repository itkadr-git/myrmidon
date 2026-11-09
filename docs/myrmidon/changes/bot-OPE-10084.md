---
settings-section: REVIEW-ROUTING: automatic reviewer for tasks in review
---

## changelog-en

### DEVFLOW: load-based review routing with lead pool and idle rebalancing (OPE-10084)

- Company review pool now dynamically includes `lead` along with `reviewer` castes.
- Participant selection at review stage start and reassignment prioritizes the least loaded agent (pending stages and active runs queue), excluding the author and escalated stages.
- Automated rebalancing during review routing sweep shifts pending stages waiting longer than `rebalanceAfterMinutes` to an idle pool member with an immediate wake.

## changelog-ru

### DEVFLOW: ревью по нагрузке — лиды в пуле ревьюеров, выбор участника по очереди и перебалансировка (OPE-10084)

- В пул ревью компании динамически включены роли `lead` наряду с `reviewer`.
- Выбор участника при старте и переназначении этапа ревью учитывает наименьшую нагрузку (очередь pending-этапов и активных прогонов), исключая автора и эскалированные этапы.
- Автоматическая перебалансировка в sweep переносит pending-этапы, ожидающие дольше `rebalanceAfterMinutes`, к свободному участнику пула ревью с немедленной побудкой.

## settings-en

| `rebalanceAfterMinutes` | `30` | Minutes a pending review waits before being rebalanced to an idle pool member (`load === 0`) with a wake. From 0 to 43200 | `0` — never rebalance |

## settings-en-replace

| `reviewerRoles` | `["reviewer", "lead"]` | Caste keys (`agents.role`) whose invokable agents may be picked as reviewers | An empty list — nobody is eligible, so every reviewer-less task is signalled as `no_reviewer` |

## settings-en-replace

| `maxLoadPerReviewer` | `5` | A reviewer already holding this many tasks in flight is not picked. From 1 to 100 | — |

## settings-ru-append

<!-- section: REVIEW-ROUTING: автоназначение ревьюера задачам на ревью -->

| `rebalanceAfterMinutes` | `30` | Сколько минут pending-этап ревью может ждать, прежде чем перейти к свободному участнику пула ревью (`load === 0`) с побудкой. От 0 до 43200 | `0` — никогда не перебалансировать |

## settings-ru-replace

| `reviewerRoles` | `["reviewer", "lead"]` | Ключи каст (`agents.role`), чьи агенты, которых можно вызвать, могут быть выбраны ревьюерами | Пустой список — выбрать некого, каждая задача без ревьюера сигналится как `no_reviewer` |

## settings-ru-replace

| `maxLoadPerReviewer` | `5` | Ревьюер, у которого уже столько задач в работе, не выбирается. От 1 до 100 | — |
