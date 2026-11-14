## changelog-en

### Lane evidence cancelled check rule matches CI summary (LANE-EVIDENCE-CANCELLED-2)

- Representative check run selection by check name is now shared between CI summary (`summarizeCheckRuns`) and pull request lane evidence (`summarizeHeadLaneEvidence`).
- A cancelled check run of the same name does not mark lane evidence red when a newer run of that check has succeeded, even if `CI result` has not finished yet.

## changelog-ru

### Правило отменённых проверок в доказательствах дорожки совпадает со сводкой CI (LANE-EVIDENCE-CANCELLED-2)

- Логика выбора представительного прогона по имени проверки теперь общая для сводки CI (`summarizeCheckRuns`) и доказательств дорожки PR (`summarizeHeadLaneEvidence`).
- Отменённая проверка не делает доказательства дорожки красными, если более поздний прогон той же проверки успешен, даже когда `CI result` ещё не завершился.
