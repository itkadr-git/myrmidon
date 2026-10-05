---
settings-section: BOT-DISK E — host disk usage signal
---

## settings-en

| `general.botDisk.pnpmStoreDir` | BOT-DISK-D | `/workspace/.pnpm-store` | The pnpm store of bots: a path under `/workspace`, `/data`, `/scratch` or `/bot` (inside the bot's single mount, so hard links work). A path elsewhere (`/cache/...` included) is refused. Replaces `pnpmStore` (removed; a stored value is ignored) | `null` — the default. The image itself defaults to the same path |
| `general.botDisk.pnpmImportMethod` | BOT-DISK-D | `hardlink` | How pnpm puts a package into a clone: `hardlink` (only hard links are tried; pnpm 9 still copies silently where the kernel refuses a link, see the self-check), `clone-or-copy` or `copy` (explicit opt-outs; every clone then holds full copies) | `null` — `hardlink` |

## settings-ru

| `general.botDisk.pnpmStoreDir` | BOT-DISK-D | `/workspace/.pnpm-store` | Хранилище pnpm у ботов: путь под `/workspace`, `/data`, `/scratch` или `/bot` (внутри единого монтирования бота, поэтому жёсткие ссылки работают). Путь в другом месте (в том числе `/cache/...`) отклоняется. Заменяет `pnpmStore` (удалён; сохранённое значение игнорируется) | `null` — по умолчанию. Образ сам по умолчанию использует тот же путь |
| `general.botDisk.pnpmImportMethod` | BOT-DISK-D | `hardlink` | Как pnpm кладёт пакет в клон: `hardlink` (пробуются только жёсткие ссылки; pnpm 9 всё равно молча копирует, где ядро отказывает, см. самопроверку), `clone-or-copy` или `copy` (явный отказ; тогда каждый клон хранит полные копии) | `null` — `hardlink` |
