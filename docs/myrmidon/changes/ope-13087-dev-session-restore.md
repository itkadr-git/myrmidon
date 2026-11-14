# 1.6.9 OPE-13087: DEV-SESSION-RESTORE

## EN

- Fixed developer session strategy: developers (`adm-dev-eng*`, `adm-dev-review*`, `isDeveloperRole`) receive task-scoped sessions (`issue`, `run`, `none`), replacing previous misinterpretation of 06.11 decision. `agent` strategy is mapped to `issue`.
- Updated documentation and code comments to clarify owner directive (Alex 06.11, clarified 14.11).

## RU

- Исправлена стратегия сеансов разработчиков: разработчики (`adm-dev-eng*`, `adm-dev-review*`, `isDeveloperRole`) получают сеанс на задачу (`issue`, `run`, `none`), исправляя неверное толкование решения 06.11. Стратегия `agent` заменяется на `issue`.
- Обновлены комментарии в коде и документация в соответствии с решением владельца (Alex 06.11, уточнено 14.11).
