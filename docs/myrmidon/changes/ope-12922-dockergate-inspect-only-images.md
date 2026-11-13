---
settings-section: 1.3 — STACK-UPDATES stack registry (SUA, parts A and B)
---

## changelog-en

### Stack registry can read host image versions through dockergate (OPE-12922)

- dockergate has a new optional `inspectOnlyImages` config list: exact image refs (tag or digest) whose image inspect is allowed read-only, with the same labels-only answer. They are never allowed for container create; only `images` is.
- The stack registry probe takes the exact refs of a docker-image component from `MYRMIDON_STACK_IMAGE_<NAME>` (for example `MYRMIDON_STACK_IMAGE_CLICKHOUSE`) instead of the tagless seed refs that resolved to `:latest` and answered 404. Unset keeps the old behaviour. Point `MYRMIDON_STACK_DOCKER_SOCKET` at the dockergate socket and list the same refs in `inspectOnlyImages`.

## changelog-ru

### Реестр стека читает версии образов хоста через dockergate (OPE-12922)

- В конфиге dockergate появился необязательный список `inspectOnlyImages`: точные ссылки образов (тег или дайджест), осмотр которых разрешён только на чтение, с тем же ответом из одних меток. Создавать контейнеры из них нельзя, только из `images`.
- Проба реестра стека берёт точные ссылки docker-image-компонента из `MYRMIDON_STACK_IMAGE_<NAME>` (например `MYRMIDON_STACK_IMAGE_CLICKHOUSE`) вместо ссылок seed без тега, которые разрешались в `:latest` и давали 404. Без переменной поведение прежнее. Укажите в `MYRMIDON_STACK_DOCKER_SOCKET` сокет dockergate и перечислите те же ссылки в `inspectOnlyImages`.
