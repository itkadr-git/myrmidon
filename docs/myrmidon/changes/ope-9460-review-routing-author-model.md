## changelog-en

### Review routing: author model separation and immediate transition assignment (OPE-9460)

When an issue enters `in_review` without an active review participant, Myrmidon now immediately evaluates review routing within the transition transaction to assign the least-loaded eligible reviewer agent. The candidate filter excludes agents whose model matches the author's model (`createdByAgentId`), ensuring diverse model evaluation across implementation and review. When no candidate with a distinct model is available, an immediate `no_reviewer` attention signal is raised.

## changelog-ru

### Маршрутизация ревью: разделение по модели автора и немедленное назначение при переходе (OPE-9460)

При переходе задачи в `in_review` без назначенного участника ревью Myrmidon немедленно внутри транзакции перехода подбирает наименее загруженного подходящего ревьюера. Кандидаты с той же моделью, что и автор задачи (`createdByAgentId`), исключаются из отбора для обеспечения разнообразия моделей между разработчиком и ревьюером. Если подходящего ревьюера с отличающейся моделью нет, немедленно создаётся attention-сигнал тревоги `no_reviewer`.
