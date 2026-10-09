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
  the new and changed skills into the company's skill catalog as company-local
  skills (`sourceKind "managed_local"` — the same shape a UI-created local
  skill gets, key `company/<companyId>/<slug>`, a `bot_backimport_agent` marker in
  the skill's metadata distinguishes them). The import also adds
  `company/<companyId>/<slug>` to the author bot's desired skills, so the
  profile compiler delivers the catalog copy back into a recreated volume —
  that is the volume-recreation criterion. A newly imported skill is set to
  lifecycle *candidate* (a bot-written, untrusted skill: it reaches the
  company's pilot agents and its own author bot through the normal delivery
  path — the compiler delivers a candidate to the agent named by the skill's
  `bot_backimport_agent` marker even outside `MYRMIDON_SKILL_PILOT_AGENTS` — and
  an operator verifies it to fleet-wide; the import never promotes). A catalog entry the
  marker does not own (a human-created skill with the same slug, another
  bot's back-import) is never overwritten — the import refuses and records
  the failure. Factory-bundled Hermes skills are filtered out by
  `skills/.bundled_manifest`, and the Hermes category layout
  `skills/<category>/<name>/SKILL.md` is read natively.
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
  переносит новые и изменённые навыки в каталог навыков компании как
  локальные навыки компании (`sourceKind "managed_local"` — тот же вид, что у
  локального навыка, созданного в UI, ключ `company/<companyId>/<slug>`,
  маркер `bot_backimport_agent` в метаданных навыка их различает). Импорт также
  добавляет `company/<companyId>/<slug>` в desired skills бота-автора, чтобы
  компилятор профиля доставил каталожную копию обратно в пересозданный том —
  это и есть критерий «пересоздание тома не теряет навык». Вновь
  импортированный навык ставится в жизненный цикл как *кандидат*
  (навык, написанный ботом, недоверенный: до пилотных агентов компании и до
  бота-автора он доходит обычным путём доставки — компилятор отдаёт кандидата
  агенту из метки `bot_backimport_agent` навыка даже вне
  `MYRMIDON_SKILL_PILOT_AGENTS`, — а оператор подтверждает его на весь флот;
  импорт никогда не продвигает сам). Каталожная запись, которой маркер не
  владеет (навык, созданный человеком с тем же slug, или back-import другого
  бота), не перезаписывается никогда — импорт отказывается и записывает
  ошибку. Встроенные навыки Hermes отсеиваются по `skills/.bundled_manifest`,
  категорийная раскладка `skills/<категория>/<имя>/SKILL.md` читается
  нативно.
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

| `MYRMIDON_BOT_SKILL_BACKIMPORT` | 1.6.5-BOT-SKILL-BACKIMPORT | off | On every reconcile pass of a live bot the board reads the bot's own skills (`hermes/skills` = the container's `~/.hermes/skills`) out of the container via the Docker archive API and upserts new and changed skills into the company's skill catalog (sourceKind `managed_local` + a `bot_backimport_agent` marker, key `company/<companyId>/<slug>`); the import also adds the key to the author bot's desired skills so the compiler re-delivers the catalog copy into a recreated volume, a new import enters the lifecycle as a candidate, and a human-created or foreign entry with the same key is never overwritten; the board's own delivery directory `hermes/skills-board` is never read back | `1`/`true`/`yes`/`on` — enable. Off or unset — the previous behavior: the reconcile pass never touches the skill read. Requires `MYRMIDON_BOT_CONTAINERS` (the reconcile pass itself) and a driver that can read the container filesystem (the local Docker driver; fleetd has no back-import) |

| `MYRMIDON_BOT_SKILL_BACKIMPORT` | 1.6.5-BOT-SKILL-BACKIMPORT | выкл | На каждом проходе реконсиляции живого бота доска читает собственные навыки бота (`hermes/skills` = `~/.hermes/skills` контейнера) из контейнера через Docker archive API и переносит новые и изменённые навыки в каталог навыков компании (sourceKind `managed_local` + маркер `bot_backimport_agent`, ключ `company/<companyId>/<slug>`); импорт также добавляет ключ в desired skills бота-автора, чтобы компилятор вернул каталожную копию в пересозданный том, новый импорт входит в жизненный цикл кандидатом, а ручная или чужая запись с тем же ключом не перезаписывается; каталог доставки доски `hermes/skills-board` обратно не читается | `1`/`true`/`yes`/`on` — включить. Выкл или не задано — прежнее поведение: проход реконсиляции не трогает чтение навыков. Требует `MYRMIDON_BOT_CONTAINERS` (сам проход реконсиляции) и драйвер, умеющий читать ФС контейнера (локальный Docker-драйвер; у fleetd обратного импорта нет) |

## divergence

| 1.6.5-BOT-SKILL-BACKIMPORT | При реконсиляции живого бота его собственные навыки (`hermes/skills`) читаются из контейнера и upsert'ятся в каталог навыков компании (sourceKind managed_local + маркер bot_backimport_agent, ключ company/<companyId>/<slug>); импорт добавляет ключ в desired skills бота-автора (переживание тома), кандидат через setCandidate, отказ перезаписывать чужие/ручные записи, встроенные навыки отфильтрованы по .bundled_manifest, категорийная раскладка читается нативно; детект изменений — хэш файлов, unchanged без версии; выключатель MYRMIDON_BOT_SKILL_BACKIMPORT (по умолчанию выкл) | `server/src/myrmidon/bot-containers/skill-backimport.ts` (правила), `skill-backimport-ports.ts` (привязка к companySkillService), `docker-driver.ts` (`readBotSkills` + `skillDirectoriesFromArchive`, метка `myrmidon(1.6.5-BOT-SKILL-BACKIMPORT)`), `driver.ts` (порт), `reconciler.ts` (вызов после успешных веток), `index.ts` + `startup.ts` (проводка db/companyId) | Навык, созданный ботом в контейнере, жил только на его томе и терялся при пересоздании тома; доска его не видела и не могла раздать другим ботам | `server/src/myrmidon/bot-containers/skill-backimport.myrmidon.test.ts` (правила: create/update/unchanged/сдерживание/выключатель), `skill-backimport-archive.myrmidon.test.ts` (разбор архива), `reconciler.myrmidon.test.ts` (блок «bot skill back-import»: выкл = прежнее поведение, вкл = импорт, падение не рушит проход) | Никогда, наша функция. При снятии: удалить файлы `skill-backimport*.ts`, куски `myrmidon(1.6.5-BOT-SKILL-BACKIMPORT)`, блоки тестов | PR в rel/1.6.5-rc.7 |
