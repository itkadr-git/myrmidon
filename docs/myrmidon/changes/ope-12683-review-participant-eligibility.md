## changelog-en

### A review goes only to a reviewer of the task's own group (OPE-12683)

- The board accepted any agent as a reviewer. The automatic review rebalance gave development reviews to shop and business bots (`bbq*`, `work*`, `dispatch`). They approved and closed tasks whose pull requests were not merged.
- A review or approval participant must now be an agent of the task's own group, with `swarmQueueEligible` not set to `false`. The board refuses any other agent with 422 `invalid_review_participant` and lists eligible teammates. The check runs when the task enters review and when the reviewer changes while the task is already in review.
- The automatic review routing takes reviewers only from the task's own group: first assignment, reassignment of an overdue review, queue offload, rebalance, and the pull request lane. There is no fallback to the whole company pool. When the group has no eligible reviewer, nothing is moved and the `no_reviewer` card is raised.
- While a review is pending, the task's group is the group of the engineer the review returns to, not the group of the reviewer who holds it.

## changelog-ru

### Ревью уходит только ревьюеру своей группы (OPE-12683)

- Доска принимала любого агента в роли ревьюера. Автоматическая перебалансировка ревью отдавала задачи разработки магазинным и бизнес-ботам (`bbq*`, `work*`, `dispatch`). Они одобряли и закрывали задачи, чьи pull request не были влиты.
- Теперь участник ревью или одобрения должен быть агентом своей группы задачи, у которого `swarmQueueEligible` не равен `false`. Доска отклоняет остальных ответом 422 `invalid_review_participant` и называет подходящих коллег. Проверка идёт при входе задачи в ревью и при смене ревьюера, когда задача уже в ревью.
- Автоматическая маршрутизация ревью берёт ревьюеров только из своей группы задачи: первое назначение, переназначение просроченного ревью, разгрузка очереди, перебалансировка и дорожка pull request. Возврата к общему пулу компании нет. Если в группе нет подходящего ревьюера, ничего не переносится, а поднимается карточка `no_reviewer`.
- Пока ревью ожидает решения, группа задачи — это группа инженера, к которому ревью вернётся, а не группа ревьюера, который его держит.
