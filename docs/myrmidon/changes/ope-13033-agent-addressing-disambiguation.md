# OPE-13033 Disambiguate text mentions / Разрешение неоднозначных текстовых упоминаний

## EN
When an `@<alias>` or `@<name>` mention matches multiple active agents in the same company, resolution refuses with an `ambiguous` status and returns the full list of candidates (names and agent IDs). The inbound message is filtered and a polite refusal is sent to the sender asking to specify the agent by ID, without creating a task or assigning to an ambiguous agent. Unique exact names and aliases continue to resolve to the single matched agent.

## RU
Когда упоминание `@<alias>` или `@<имя>` совпадает с несколькими активными агентами одной компании, разрешение отклоняется со статусом `ambiguous` и возвращает полный перечень кандидатов (имена и ID агентов). Входящее сообщение фильтруется, а отправителю возвращается явный отказ с перечислением кандидатов с просьбой указать ID агента, без создания задачи или автоматического назначения на одного из них. Уникальные точные имена и псевдонимы разрешаются в единственного адресата, как и прежде.
