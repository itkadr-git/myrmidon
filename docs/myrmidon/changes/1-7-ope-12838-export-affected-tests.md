## changelog-en

- CI test planner: a PR that changes an exported interface, type, or signature no longer escalates the whole run to the full tier. The planner walks the workspace import graph from the changed file and runs only the tests that reach it. The run stays full only when a test imports a workspace specifier the planner cannot resolve, when no test reaches the change, or when test data is missing. Measured on merged PRs 2026-11-10..12: 2 of 40 (5%) hit the old blanket escalation.

## changelog-ru

- CI-планировщик тестов: PR, меняющий публичный экспорт, интерфейс или тип, больше не переводит весь прогон в полный уровень. Планировщик идёт по графу импортов workspace от изменённого файла и запускает только те тесты, которые до него доходят. Полный прогон остаётся только когда тест импортирует workspace-спецификатор, который планировщик не может разрешить, когда до изменения не доходит ни один тест или когда нет данных о тестах. Замер по слитым PR за 10–12.11.2026: 2 из 40 (5%) падали в полный уровень по старому правилу.
