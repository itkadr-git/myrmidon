## settings-en-replace

| `general.botDisk.sharedCacheRoles` | 1.6.2-BOT-DISK-C | `engineer`, `lead`, `reviewer`, `devops`, `release`, `qa` | Agent roles (`agents.role`) whose bots get the shared package cache and git mirror mounts and variables. `lead` joined the coding roles (OPE-12384): a lead bot runs the same devbuild/build toolchain on the same repositories as the engineers it reviews. Every other bot (marketing, support, …) gets none, so enabling the cache does not recreate it or show profile drift. Applies without a restart: a change recreates exactly the bots whose membership changes | `null` — the default list; `[]` — no bot gets the cache |

## settings-ru-replace

| `general.botDisk.sharedCacheRoles` | 1.6.2-BOT-DISK-C | `engineer`, `lead`, `reviewer`, `devops`, `release`, `qa` | Роли агентов (`agents.role`), чьи боты получают монтирования и переменные общего кэша пакетов и зеркал git. `lead` в области по умолчанию вместе с инженерными ролями (OPE-12384): лид-бот работает с той же devbuild/сборочной цепочкой на тех же репозиториях, что и инженеры, которых он ревьюит. Остальные боты (маркетинг, поддержка, …) их не получают, так что включение кэша их не пересоздаёт и дрейфа профиля нет. Применяется без перезапуска: изменение пересоздаёт ровно тех ботов, чья принадлежность изменилась | `null` — список по умолчанию; `[]` — кэш не получает ни один бот |
