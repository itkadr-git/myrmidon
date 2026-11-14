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

## settings-en

| `MYRMIDON_STACK_IMAGE_<NAME>` | SUA | unset | Exact image refs (tag or digest, comma-separated) the local probe of the docker-image component `<NAME>` inspects (component name upper-cased, `-` becomes `_`: `MYRMIDON_STACK_IMAGE_CLICKHOUSE`, `MYRMIDON_STACK_IMAGE_HERMES_AGENT`, `MYRMIDON_STACK_IMAGE_BASE_IMAGES`). Refs are used untouched (no tag stripping); unset keeps the seed refs, inspected as `:latest`. Through dockergate the same refs must be listed in its `inspectOnlyImages` and `MYRMIDON_STACK_DOCKER_SOCKET` must point at the dockergate socket (`/run/myrmidon-dockergate/engine.sock`); read on every refresh | Leave unset to keep the seed refs |

## settings-ru

| `MYRMIDON_STACK_IMAGE_<NAME>` | SUA | не задана | Точные ссылки образов (тег или дайджест, через запятую), которые локальная проба docker-image-компонента `<NAME>` осматривает (имя компонента в верхнем регистре, `-` заменяется на `_`: `MYRMIDON_STACK_IMAGE_CLICKHOUSE`, `MYRMIDON_STACK_IMAGE_HERMES_AGENT`, `MYRMIDON_STACK_IMAGE_BASE_IMAGES`). Ссылки берутся как есть (тег не отрезается); без переменной остаются ссылки из seed, осматриваемые как `:latest`. Через dockergate те же ссылки должны быть в его `inspectOnlyImages`, а `MYRMIDON_STACK_DOCKER_SOCKET` указывать на сокет dockergate (`/run/myrmidon-dockergate/engine.sock`); читается при каждом refresh | Не задавать, чтобы остались ссылки из seed |
