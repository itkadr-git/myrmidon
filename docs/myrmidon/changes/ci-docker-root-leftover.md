## changelog-en

### CI Go tool checks no longer leave root-owned files that break the next checkout

The Go checks (`tools/dockergate`, `tools/fleetd`) ran in a Docker container as
root with the workspace mounted, so files they created in the reused
self-hosted runner workspace were owned by root. The next job's checkout could
not clean the workspace and failed (`fatal: --local can only be used inside a
git repository`), taking down every job on that runner. These containers now
run as the runner user (`--user "$(id -u):$(id -g)"`, `HOME=/tmp`). The Go
jobs on the self-hosted lane also start with a step, before checkout, that
detects files owned by another user, prints their paths, hands them back to the
runner user with a throwaway container and fails with a clear error if that
does not help.

## changelog-ru

### Go-проверки CI больше не оставляют файлы root, ломающие следующий checkout

Go-проверки (`tools/dockergate`, `tools/fleetd`) запускались в контейнере Docker
от root с примонтированным рабочим каталогом, поэтому созданные ими файлы в
переиспользуемом рабочем каталоге собственного раннера принадлежали root.
Следующий checkout не мог очистить каталог и падал (`fatal: --local can only be
used inside a git repository`), из-за чего ломались все задания раннера. Теперь
эти контейнеры работают от пользователя раннера (`--user "$(id -u):$(id -g)"`,
`HOME=/tmp`). Go-задания на собственных раннерах дополнительно начинаются с
шага до checkout: он находит файлы чужого владельца, печатает их пути, возвращает
владение пользователю раннера одноразовым контейнером и падает с понятной
ошибкой, если это не помогло.
