---
settings-section: 1.3 — STACK-UPDATES stack registry (SUA, parts A and B)
---

## changelog-en

### Auto-created backlog drafts for lagging or security-flagged stack components (1.7-STACK-UPDATES-B)

- The daily stack release check now creates a backlog draft task (`todo`, `originKind stack_update`) per component that lags upstream by the configured number of releases or carries a critical security note — previously the check only produced attention cards and the draft had to be written by hand from the UI.
- Deduplication: while an open task for the same component exists (`originKind stack_update`, `originId` = component name, status not done/cancelled), no duplicate draft is created.
- The draft title and summary reuse the attention card wording, so the backlog draft and the "needs me" feed stay consistent; a security-only component (no lag, hence no attention card) gets a title/summary in the same shape.
- The lag threshold is configured with `MYRMIDON_STACK_BACKLOG_LAG_RELEASES` (default 2); the draft-creation step is injectable (`createDraft`/`findOpenComponents` ports in `checkStackReleases`), failures are logged per company without failing the check.

## changelog-ru

### Автосоздание черновиков задач в бэклоге по отстающим или security-помеченным компонентам стека (1.7-STACK-UPDATES-B)

- Ежедневная сверка релизов стека теперь создаёт черновик-задачу в бэклоге (`todo`, `originKind stack_update`) для компонента, отставшего от upstream на настроенное число релизов или с критической security-заметкой — раньше сверка давала только attention-карточки, а черновик приходилось заводить вручную из UI.
- Дедупликация: пока по компоненту открыта задача (`originKind stack_update`, `originId` = имя компонента, статус не done/cancelled), дубликат не создаётся.
- Заголовок и сводка черновика берутся из attention-карточки, поэтому черновик и лента «нужно мне» остаются согласованными; компонент только с security-пометкой (без отставания, значит без карточки) получает заголовок/сводку той же формы.
- Порог отставания настраивается переменной `MYRMIDON_STACK_BACKLOG_LAG_RELEASES` (по умолчанию 2); шаг создания черновиков внедряется через порты `createDraft`/`findOpenComponents` в `checkStackReleases`, сбой создания пишется в лог по компании и не валит сверку.

## settings-en

| `MYRMIDON_STACK_BACKLOG_LAG_RELEASES` | 1.7-STACK-UPDATES-B | `2` | Minimum upstream release lag that warrants creating a backlog draft task (`todo`, `originKind stack_update`) during the daily stack check; a component with a critical security note gets a draft regardless of lag, and no duplicate is created while an open task for the same component exists | Unset, non-numeric or less than 1 — defaults to 2 |

## settings-ru

| `MYRMIDON_STACK_BACKLOG_LAG_RELEASES` | 1.7-STACK-UPDATES-B | `2` | Минимальное отставание от upstream (в релизах), при котором ежедневная сверка стека создаёт черновик-задачу в бэклоге (`todo`, `originKind stack_update`); компонент с критической security-заметкой получает черновик независимо от отставания, и дубликат не создаётся, пока по компоненту открыта задача | Не задана, не число или меньше 1 — по умолчанию 2 |
