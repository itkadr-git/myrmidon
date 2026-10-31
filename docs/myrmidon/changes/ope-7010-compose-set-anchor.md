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
