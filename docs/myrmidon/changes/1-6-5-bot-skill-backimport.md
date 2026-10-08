---
divergence-section: Трек 5 — эксплуатация
settings-section: Bot containers (G-series, the 28.09 "option B" plan)
---

## changelog-en

### Bot-created skills are imported back into the board's skill catalog (1.6.5 BOT-SKILL-BACKIMPORT)

- A skill a bot creates at runtime lives in its container at
  `~/.hermes/skills` on the bot's volume and used to vanish with a volume
  recreation. With `MYRMIDON_BOT_SKILL_BACKIMPORT=1` (off by default) every
  reconcile pass of a live bot also reads that directory back out of the
  container (Docker archive API; no exec, no container change) and upserts
  the new and changed skills into the company's skill catalog
  (`sourceKind "bot_backimport"`, key `company/<companyId>/<slug>`). The
  normal lifecycle and profile compiler then deliver them back — to the same
  bot after a volume loss, and to the company's pilot agents as lifecycle
  candidates (an operator verifies a candidate to fleet-wide; the import
  never promotes).
- Change detection is a content hash over the skill's file set: a skill whose
  files match the catalog copy is skipped without a version cut, so an
  untouched bot skill does not grow a version per sweep. An update rewrites
  the catalog skill's managed directory to exactly the container copy (a file
  the bot deleted disappears) and cuts one version.
- The board's own delivery directory `hermes/skills-board` is never read
  back: it is the profile's managed content, and re-importing it would echo
  the catalog into itself. A skill the bot copied or edited under its own
  `hermes/skills` imports as the company's own copy — from the catalog's
  point of view that is what "the bot changed it" means.
- Containment: a skill over the file ceilings (200 files / 512 KiB per file,
  the compiler's own limits), with a binary or path-unsafe file, or without a
  SKILL.md is dropped whole; a failing import of one skill is recorded in the
  bot's activity log and never fails the reconcile pass or the other skills.
  A driver that cannot read the container filesystem (fleetd) simply has no
  back-import.
- Flag off = byte-identical previous behavior: the reconcile pass never
  touches the skill read.

## changelog-ru

### Навыки, созданные ботом, возвращаются в каталог навыков доски (1.6.5 BOT-SKILL-BACKIMPORT)

- Навык, созданный ботом в рантайме, живёт в его контейнере в
  `~/.hermes/skills` на томе бота и раньше терялся при пересоздании тома. С
  `MYRMIDON_BOT_SKILL_BACKIMPORT=1` (по умолчанию выкл) каждая
  реконсиляция живого бота дополнительно читает этот каталог обратно из
  контейнера (Docker archive API; без exec, без изменений контейнера) и
  переносит новые и изменённые навыки в каталог навыков компании
  (`sourceKind "bot_backimport"`, ключ `company/<companyId>/<slug>`). Дальше
  обычный жизненный цикл и компилятор профиля отдают их обратно — тому же
  боту после потери тома и пилотным агентам компании как кандидатам
  (оператор подтверждает кандидата на весь флот; импорт никогда не
  продвигает сам).
- Детект изменений — хэш содержимого файлов навыка: навык, чьи файлы совпали
  с каталожной копией, пропускается без новой версии, поэтому нетронутый
  навык не растит версию на каждый проход. Обновление перезаписывает
  управляемый каталог навыка ровно в контейнерную копию (удалённый ботом файл
  исчезает) и режет одну версию.
- Собственный каталог доставки доски `hermes/skills-board` обратно не
  читается: это управляемое содержимое профиля, и его импорт эхом вернул бы
  каталог сам в себя. Навык, который бот скопировал или изменил под своим
  `hermes/skills`, импортируется как собственная копия компании — с точки
  зрения каталога это и есть «бот его изменил».
- Сдерживание: навык сверх потолков (200 файлов / 512 КиБ на файл — те же
  лимиты, что у компилятора), с бинарным или небезопасным по пути файлом или
  без SKILL.md отбрасывается целиком; падение импорта одного навыка
  записывается в журнал активности бота и никогда не рушит проход
  реконсиляции или остальные навыки. Драйвер, который не умеет читать ФС
  контейнера (fleetd), просто остаётся без обратного импорта.
- Выкл = прежнее поведение байт в байт: проход реконсиляции вообще не трогает
  чтение навыков.

## settings-en

| `MYRMIDON_BOT_SKILL_BACKIMPORT` | 1.6.5-BOT-SKILL-BACKIMPORT | off | On every reconcile pass of a live bot the board reads the bot's own skills (`hermes/skills` = the container's `~/.hermes/skills`) out of the container via the Docker archive API and upserts new and changed skills into the company's skill catalog (`sourceKind "bot_backimport"`, key `company/<companyId>/<slug>`), so a bot-created skill survives a volume recreation and is delivered back by the normal profile compile; the board's own delivery directory `hermes/skills-board` is never read back | `1`/`true`/`yes`/`on` — enable. Off or unset — the previous behavior: the reconcile pass never touches the skill read. Requires `MYRMIDON_BOT_CONTAINERS` (the reconcile pass itself) and a driver that can read the container filesystem (the local Docker driver; fleetd has no back-import) |

| `MYRMIDON_BOT_SKILL_BACKIMPORT` | 1.6.5-BOT-SKILL-BACKIMPORT | выкл | На каждом проходе реконсиляции живого бота доска читает собственные навыки бота (`hermes/skills` = `~/.hermes/skills` контейнера) из контейнера через Docker archive API и переносит новые и изменённые навыки в каталог навыков компании (`sourceKind "bot_backimport"`, ключ `company/<companyId>/<slug>`), поэтому созданный ботом навык переживает пересоздание тома и возвращается обычной компиляцией профиля; каталог доставки доски `hermes/skills-board` обратно не читается | `1`/`true`/`yes`/`on` — включить. Выкл или не задано — прежнее поведение: проход реконсиляции не трогает чтение навыков. Требует `MYRMIDON_BOT_CONTAINERS` (сам проход реконсиляции) и драйвер, умеющий читать ФС контейнера (локальный Docker-драйвер; у fleetd обратного импорта нет) |

## divergence

| 1.6.5-BOT-SKILL-BACKIMPORT | При реконсиляции живого бота его собственные навыки (`hermes/skills`) читаются из контейнера и upsert'ятся в каталог навыков компании (sourceKind bot_backimport, ключ company/<companyId>/<slug>); детект изменений — хэш файлов, unchanged без версии; выключатель MYRMIDON_BOT_SKILL_BACKIMPORT (по умолчанию выкл) | `server/src/myrmidon/bot-containers/skill-backimport.ts` (правила), `skill-backimport-ports.ts` (привязка к companySkillService), `docker-driver.ts` (`readBotSkills` + `skillDirectoriesFromArchive`, метка `myrmidon(1.6.5-BOT-SKILL-BACKIMPORT)`), `driver.ts` (порт), `reconciler.ts` (вызов после успешных веток), `index.ts` + `startup.ts` (проводка db/companyId) | Навык, созданный ботом в контейнере, жил только на его томе и терялся при пересоздании тома; доска его не видела и не могла раздать другим ботам | `server/src/myrmidon/bot-containers/skill-backimport.myrmidon.test.ts` (правила: create/update/unchanged/сдерживание/выключатель), `skill-backimport-archive.myrmidon.test.ts` (разбор архива), `reconciler.myrmidon.test.ts` (блок «bot skill back-import»: выкл = прежнее поведение, вкл = импорт, падение не рушит проход) | Никогда, наша функция. При снятии: удалить файлы `skill-backimport*.ts`, куски `myrmidon(1.6.5-BOT-SKILL-BACKIMPORT)`, блоки тестов | PR в rel/1.6.5-rc.7 |
