---
divergence-section: REVIEW-ROUTING — автоназначение ревьюера задачам на ревью
settings-section: REVIEW-ROUTING: automatic reviewer for tasks in review
---

## changelog-en

### Review routing: timer-based reassignment of stalled green-CI reviews (OPE-10731)

- Stalled reviews on tasks with green CI (`head.ci === "green"`) and no verdict (`head.reviewDecision === null`) are now reassigned to another eligible reviewer of the same caste after `reassignAfterMinutes` minutes.
- Reassignment prioritizes idle agents (`status === "idle"`, zero active runs, or zero load) before least-loaded agents; the author, the executor, and reviewers who previously lapsed or had the task are excluded.
- The `reassignAfterMinutes` setting is configurable in `instance_settings.general.reviewRouting` (Company Settings → Review routing) with range 0–129600 minutes (0 disables minute-based reassignment), taking precedence over `reassignAfterHours`.

## changelog-ru

### Маршрутизация ревью: переназначение зависших ревью с зелёным CI по таймеру (OPE-10731)

- Задачи в `in_review` с зелёным CI (`head.ci === "green"`) и без вердикта (`head.reviewDecision === null`) теперь переназначаются следующему подходящему ревьюеру той же касты по истечении `reassignAfterMinutes` минут.
- При подборе нового ревьюера приоритет отдаётся простаивающим агентам (`idle`, 0 активных прогонов или нулевая нагрузка), затем наименее загруженным; автор, исполнитель и ранее упустившие ревьюеры исключаются.
- Настройка `reassignAfterMinutes` задаётся в `instance_settings.general.reviewRouting` (Настройки компании → Маршрутизация ревью) в диапазоне 0–129600 минут (0 отключает переназначение по минутам) и имеет приоритет над `reassignAfterHours`.

## settings-en

| `reassignAfterMinutes` | — | Minutes a review on an issue with green CI (`head.ci === "green"`) and no verdict (`head.reviewDecision === null`) may stay before being moved to another reviewer of the same role. Takes precedence over `reassignAfterHours` when set. From 0 to 129600 | `0` — disable minute-based reassignment |

## settings-ru

| `reassignAfterMinutes` | — | Сколько минут ревью по задаче с зелёным CI (`head.ci === "green"`) и без вердикта (`head.reviewDecision === null`) может идти без вердикта, прежде чем этап ревью будет передан другому ревьюеру той же касты. При указании имеет приоритет над `reassignAfterHours`. От 0 до 129600 | `0` — отключить переназначение по минутам |

## divergence-replace

<!-- section: REVIEW-ROUTING — автоназначение ревьюера задачам на ревью -->
| REVIEW-ROUTING | Задача, перешедшая в `in_review` без участника ревью, сама получает стадию ревью с наименее загруженным (и приоритетно простаивающим) ревьюером из ролей-ревьюеров (не автор и не исполнитель задачи, без ранее упустивших ревьюеров, не выше потолка нагрузки); когда ревьюера нет — карточка внимания `review_routing` (`no_reviewer`), а не тишина; ревью без вердикта дольше заданных часов (или минут при зелёном CI по `reassignAfterMinutes`) — карточка `review_overdue` (для часов) и передача другому ревьюеру. Настройки (`enabled`, `reviewerRoles`, `maxLoadPerReviewer`, `reassignAfterHours`, `reassignAfterMinutes`) — в `instance_settings.general.reviewRouting`, экран «Review routing» в Company Settings, действуют без перезапуска. Проход на тике планировщика с интервалом 60 с; стадия строится вендорным `applyIssueExecutionPolicyTransition`, запись — через `issueService.update` под блокировкой строки | `server/src/services/attention.ts` (источник и карточки), `server/src/services/decision-queues.ts` (проверка источника), `server/src/services/instance-settings.ts` (ключ сохраняется), `server/src/index.ts`, `server/src/app.ts`, `packages/shared/src/{index.ts,types/attention.ts,types/instance.ts,validators/instance.ts}`, `ui/src/{App.tsx,lib/attention.ts,components/access/CompanySettingsNav.tsx}`, `ui/src/i18n/myrmidon-locales/*.json`; + `server/src/myrmidon/review-routing/`, `packages/shared/src/myrmidon-review-routing.ts`, `ui/src/components/myrmidon/review-routing/` | Задачи уходили в `in_review` без ревьюера и сутками ждали ручного назначения | `server/src/myrmidon/review-routing/policy.myrmidon.test.ts`, `server/src/myrmidon/review-routing/sweep.myrmidon.test.ts`, `packages/shared/src/myrmidon-review-routing.test.ts`, `ui/src/components/myrmidon/review-routing/ReviewRoutingScreen.myrmidon.test.tsx` | Никогда — наше поведение; если вендор сам назначит ревьюера при переходе в `in_review`, убрать sweep и источник `review_routing` | (этот PR) |
