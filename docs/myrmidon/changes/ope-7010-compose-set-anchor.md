---
divergence-section: Трек 5 — эксплуатация
settings-section: Track 5 — operations
---

## changelog-en

### Release deploy records compose-set anchor changes (OPE-7010)

- After the board health check, the release deploy compares the live `com.docker.compose.project.config_files` label with the `board-mount-set` block in the configured anchor file.
- When the compose-file set differs, the deploy rewrites the block with one fragment per line and commits the anchor in the configured Git repository with the deploy reference and image digest. A matching set is a no-op.
- `MYRMIDON_COMPOSE_SET_ANCHOR_FILE`, `MYRMIDON_COMPOSE_SET_ANCHOR_GIT`, and `MYRMIDON_COMPOSE_SET_LABEL_SOURCE` configure the optional sync. An empty anchor-file setting skips it; malformed or uncommittable anchors produce a warning and never fail an otherwise healthy deploy.

## changelog-ru

### Релизный деплой регистрирует изменения набора compose-файлов (OPE-7010)

- После проверки здоровья борта релизный деплой сравнивает живую метку `com.docker.compose.project.config_files` с блоком `board-mount-set` в настроенном файле-якоре.
- При расхождении наборов деплой переписывает блок: по одному фрагменту в строке, и коммитит якорь в настроенном Git-репозитории с ссылкой на деплой и digest образа. Совпадающий набор не меняется.
- Опциональная синхронизация настраивается через `MYRMIDON_COMPOSE_SET_ANCHOR_FILE`, `MYRMIDON_COMPOSE_SET_ANCHOR_GIT` и `MYRMIDON_COMPOSE_SET_LABEL_SOURCE`. Пустой путь к якорю отключает шаг; поврежденный якорь или ошибка коммита дают предупреждение и не отменяют здоровый деплой.

## divergence

| COMPOSE-SET-ANCHOR | Релизный деплой сверяет живую метку config_files с якорем board-mount-set после проверки здоровья борта и коммитит обновление блока при расхождении | scripts/myrmidon/deploy/{deploy.sh,lib.sh,deploy.env.example} | OPE-7010 (дрейф 07.10): деплой сам меняет набор -f и должен регистрировать изменение в якоре без ручных правок | scripts/myrmidon/deploy/deploy.test.mjs (секция compose-set anchor sync) | Никогда, наше поведение. Удалить шаг sync_compose_set_anchor и вызов в deploy.sh | (этот PR) |

## settings-en

| `MYRMIDON_COMPOSE_SET_ANCHOR_FILE` | COMPOSE-SET-ANCHOR | unset (step skipped) | Deploy-script setting (`deploy.env`): path to the markdown file containing the `<!-- board-mount-set:begin/end -->` anchor block | Empty or unset — the step is skipped with a log line |
| `MYRMIDON_COMPOSE_SET_ANCHOR_GIT` | COMPOSE-SET-ANCHOR | unset | Deploy-script setting (`deploy.env`): Git repository root directory of the anchor file where the sync commit is made | Empty or unset — rewritten file is kept uncommitted with a warning |
| `MYRMIDON_COMPOSE_SET_LABEL_SOURCE` | COMPOSE-SET-ANCHOR | unset | Deploy-script setting (`deploy.env`): optional shell command that prints the live container's config_files label (overrides `docker inspect` for testing) | Empty or unset — inspects local docker container `paperclip-server-1` |

## settings-ru

| `MYRMIDON_COMPOSE_SET_ANCHOR_FILE` | COMPOSE-SET-ANCHOR | не задана (шаг пропущен) | Настройка скриптов выката (`deploy.env`): путь к файлу markdown с блоком якоря `<!-- board-mount-set:begin/end -->` | Пустая или не задана — шаг пропускается с записью в лог |
| `MYRMIDON_COMPOSE_SET_ANCHOR_GIT` | COMPOSE-SET-ANCHOR | не задана | Настройка скриптов выката (`deploy.env`): корень git-репозитория файла-якоря, куда коммитится обновление | Пустая или не задана — переписанный файл сохраняется без коммита с предупреждением |
| `MYRMIDON_COMPOSE_SET_LABEL_SOURCE` | COMPOSE-SET-ANCHOR | не задана | Настройка скриптов выката (`deploy.env`): опциональная команда оболочки для чтения метки config_files контейнера (для тестов и стендов) | Пустая или не задана — метка читается через docker inspect контейнера `paperclip-server-1` |
