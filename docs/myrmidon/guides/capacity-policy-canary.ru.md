# Канарейка capacity policy

## Status — Состояние

PLANNED / NOT EXECUTED. Это описанный план, не исполненная канарейка.
Документ не разрешает production canary, включение флага, выкат или доступ к
боевым данным. Релиз и выполнение на production принадлежат ADM.
Подготовка не равна интеграционной приёмке.

## Prerequisites — Предусловия

До запуска зафиксировать merge и зелёный CI OPE-9201 (реальные источники и
подключение producer), OPE-9170 (B11) и OPE-9202 (project-scoped runtime switch).
PR #1908 задаёт provider contract, но не доказывает реальный сбор данных.

Предлагаемая точка регистрации B11: импорт `CAPACITY_POLICY_PANELS` из
`server/src/myrmidon/monitoring/dashboard/capacity-policy.ts`, вызов
`assertCapacityPolicySourcesRegistered()` и запрос через существующий adapter.
Согласование владельца B11 ещё требуется. Здесь нет side-effect регистрации
или правок существующего UI. null/отсутствующая/устаревшая серия — unavailable,
не ноль. Сохранять labels project/reason, не суммировать реплики одного snapshot
и не приписывать глобальным readiness/age/starvation несуществующий project scope.

ADM должен указать утверждённый источник operational thresholds, окно наблюдения,
допустимую давность данных, пилотный и контрольный проекты и разрешение запуска.
В прочитанном design OPE-8312 нет §5.12 и численных лимитов. Численные пороги
этим документом не утверждены. Реальные API/команды настройки взять из принятого
OPE-9202; shared schema не является доказательством существования endpoint.

## Per-project enablement — Включение по проекту

1. ADM фиксирует release revision, ID пилота и контрольного проекта. Остальные
   проекты остаются выключенными. Из OPE-9202 берёт точный путь настройки/read-back.
2. Снять disabled baseline и контроль за согласованное окно. Проверить свежие
   реальные данные всех пяти панелей в одном company/role/instance scope.
3. Записать источник порогов, значения, единицы, направления сравнения и окна.
   Без любого из этих данных включение запрещено.
4. Только после отдельного разрешения ADM включает enabled=true для пилота,
   читает effective policy и проверяет действие со следующего тика без рестарта.
   Контрольный и остальные проекты не должны измениться.
5. Наблюдать то же окно и scope. Перед расширением проверить stop conditions.
   Каждый следующий проект требует зафиксированной приёмки ADM.

## Stop thresholds — Пороги остановки

| Метрика | Условие |
| --- | --- |
| `myrmidon_readiness_ratio` | Регрессия против baseline сверх утверждённого bound/window. |
| `myrmidon_queue_age_seconds` | Максимальный ready-episode age выше утверждённого лимита. |
| `myrmidon_project_share` | Нарушение утверждённой effective fairness policy с учётом спроса и окна. |
| `myrmidon_starvation_total` | Новые starvation episodes сверх утверждённого delta limit. |
| `myrmidon_claim_rejection_total` | Delta по reason выше утверждённого reason-specific лимита относительно baseline. |

Counters сравнивать по приращениям с учётом reset producer, не по абсолютным
значениям. Численные пороги и окна остаются предусловием релиза.
`fairness.perProjectMaxShare` и `starvation.afterMin` — входы policy, не alarm SLO;
значения schema defaults нельзя объявлять operational thresholds.
Отсутствие/устаревание данных, source error, неверный scope, нарушение claim
invariants или отказ выключателя останавливают расширение и требуют отката.
При нарушении безопасности нельзя ждать численного превышения на панели.

## Rollback — Откат

1. ADM через реальный K11 interface выставляет enabled=false всем включённым
   пилотам. Записывает project ID, время и effective policy до/после.
   Не угадывать endpoint и не заменять runtime rollback рестартом процесса.
2. Прочитать enabled=false, проверить legacy ordering со следующего тика,
   сохранность настроек остальных проектов и claim invariants.
3. Наблюдать согласованное recovery window; сравнить очередь и rejection deltas
   с baseline, сохранить данные и producer resets.
4. При отказе переключения/неподтверждённом восстановлении прекратить расширение,
   эскалировать ADM с точным scope и доказательствами. Не выполнять выкат отсюда.

## Evidence — Доказательства

Канарейка не исполнена. Отдельно от плана записать release SHA/image digest,
merged revisions K10/B11/K11 и CI runs, registration assertion и timestamp реальных
samples, project IDs, effective settings, утверждённый источник и значения порогов,
baseline/control/canary windows, наблюдения пяти панелей, решение и владельца,
rollback read-back и подтверждение следующего тика.

Структурные тесты проверяют пять панелей, настоящий METRIC_FAMILIES, отказ при
незарегистрированном source и разделы документов. Зелёный preparation test при
unavailable source не доказывает интеграционную приёмку. B11 rendering, реальный
producer и переключение K11 остаются обязательными delivery gates.
