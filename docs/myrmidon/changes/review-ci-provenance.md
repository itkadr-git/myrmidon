## changelog-en

### Review gate CI evidence and diagnostics

- The review gate can reuse fresh, server-fetched authoritative terminal CI evidence for the matching company, PR and exact head. Stale, pending, ambiguous or changed-head evidence does not prove a green result. Budget denial and network errors remain distinguishable. See [PR #4547](https://github.com/itkadr-git/myrmidon/pull/4547).

## changelog-ru

### Подтверждение CI для ревью и диагностика

- Гейт ревью может повторно использовать свежий достоверный завершённый результат CI, полученный сервером для той же компании, PR и точной головы. Просроченные, незавершённые, неоднозначные данные или данные для другой головы не подтверждают зелёный результат. Отказ из-за бюджета и сетевую ошибку можно различить. См. [PR #4547](https://github.com/itkadr-git/myrmidon/pull/4547).
