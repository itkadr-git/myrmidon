# Имя продукта в документации

> English version: [docs-branding.md](docs-branding.md)

Продукт в пользовательской и операторской документации `docs/` называется
**Myrmidon**. Имя вендора **Paperclip** остаётся только там, где этого требуют
лицензия и происхождение кода: `LICENSE`, сторонние уведомления (`NOTICE`,
`ui/public/fonts/NOTICE.md`, …) и строка атрибуции «Based on Paperclip (MIT)»
на экране About и в экспортируемом README.

## Что переименовано (REBRAND E, 1.7)

Все прозаические упоминания продукта в `docs/**` теперь называют его
Myrmidon — руководства, API-документация, документы по выкату, спеки и
манифест сайта документации (`docs/docs.json`, имя сайта — «Myrmidon»).
Стартовая страница `docs/start/what-is-paperclip.md` сохраняет имя файла ради
совместимости ссылок; её содержимое и заголовок в навигации сайта называют
Myrmidon.

## Что остаётся Paperclip — намеренно

Эти идентификаторы не переименованы, потому что переименование сломало бы
установленные системы, навыки агентов или перенос обновлений вендора. Они
перечислены в аллоулисте `scripts/myrmidon/docs-branding-guard.mjs` и живут до
тех пор, пока эпики-владельцы не переименуют сначала код:

- npm-пакеты `@paperclipai/*` и CLI `paperclipai` (`npx paperclipai …`).
- Переменные окружения `PAPERCLIP_*`, HTTP-заголовки `X-Paperclip-*` и адреса
  репозитория вендора `github.com/paperclipai/paperclip`.
- Внутренний путь навыков `skills/paperclip/` и имена навыков агентов вроде
  `paperclip-create-agent`, `paperclip-operations`, `hindsight-paperclip`.
- Идентификаторы рантайма и контейнеров в примерах для оператора: юнит
  `paperclip`, имена образов и контейнеров Docker (`paperclip`,
  `paperclip-local`, `paperclip-db`, `paperclip-server`), примеры имён
  ресурсов AWS в `docs/deploy/aws-ecs.md` (`paperclip-ecs`, `paperclip-alb`,
  `paperclip-rds`, `paperclip-efs`, …), имя базы по умолчанию и
  `DATABASE_APPLICATION_NAME=paperclip`, пути данных (`~/.paperclip/…`,
  `docker-paperclip`, `paperclip-ext/…`).
- Идентификаторы протокола в `docs/specs/external-task-protocol.md`
  (`originSide=paperclip`, `paperclipValue`, `lastPaperclipFingerprint`,
  `paperclipUrl`, …) и ключи конфигурации вроде `paperclip.adapterUiParser`,
  `paperclip.manifest.json`, сид-компонент `paperclip` реестра стека.
- Названия сторонних продуктов: **Paperclip Cloud**, **Paperclip Labs**,
  **Paperclip EE**, **Paperclip Enterprise** — внешние сервисы вендора, не наш
  продукт.
- Исторические записи: `docs/myrmidon/CHANGELOG{,.ru}.md` и журналы
  `docs/myrmidon/tracks/*.md` описывают прошлые состояния и сохраняют имена,
  верные на тот момент (например, тег образа `paperclip:2026.916.1` до
  переименования, старые тексты уведомлений, которые сервер ещё распознаёт).

## Совместимость

Старые имена работают как алиасы один релиз (1.7): сервер распознаёт тексты
уведомлений, записанные до переименования, имена файлов страниц документации не
менялись, и ни один URL или идентификатор, от которого зависят агенты или
установки, не переименован. Алиасы снимаются не раньше 1.8.

## Проверка

`node scripts/myrmidon/docs-branding-guard.mjs` роняет CI, если в `docs/`
появляется новое упоминание «Paperclip» вне аллоулиста. Когда следующий эпик
переименовывает идентификатор (пакеты, переменные окружения, пути API), запись
удаляется из аллоулиста, а документация правится в том же PR.

Если новый документ упоминает сохранённый идентификатор в новой формулировке,
аллоулист в `scripts/myrmidon/docs-branding-guard.mjs` дополняется, а изменение
записывается в `docs/myrmidon/DIVERGENCE.md`.
