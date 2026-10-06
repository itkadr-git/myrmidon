## changelog-en

### Bot runtime builds hermes from the author's repository (HERMES-UPSTREAM)

- The bot image now clones hermes-agent from `NousResearch/hermes-agent` at the pinned tag and commit (`HERMES_GIT_REF`, `HERMES_GIT_SHA`) instead of a separate mirror fork. The fork was a byte-identical mirror; our hermes changes already live in `docker/bot-runtime/patches/`. The pinned commit keeps the build reproducible.

## changelog-ru

### Рантайм ботов собирает hermes из репозитория автора (HERMES-UPSTREAM)

- Образ бота клонирует hermes-agent из `NousResearch/hermes-agent` по закреплённому тегу и коммиту (`HERMES_GIT_REF`, `HERMES_GIT_SHA`) вместо отдельного форка-зеркала. Форк был побайтовым зеркалом; наши правки hermes уже лежат в `docker/bot-runtime/patches/`. Закреплённый коммит сохраняет воспроизводимость сборки.
