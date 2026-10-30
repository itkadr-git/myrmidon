---
divergence-section: KNOWLEDGE-2.0 — единый модуль знаний
settings-section: Track 5 — operations
---

## changelog-en

### Knowledge module part L-8: nightly deterministic Git export (KNOWLEDGE-2.0 L-8)

- New `server/src/myrmidon/knowledge/git-export*.ts`: the knowledge tree is
  exported once per interval (24 h by default) into a branch of a Git
  repository as Markdown, one file per page. The same set of pages always
  yields the same bytes, so an unchanged tree makes no commit; a deleted page
  disappears from the branch. The `life` section never leaves the database.
  Each company lives in its own `<companyId>/` directory of the shared
  repository; one company never deletes another's pages. Errors from git are
  logged with credentials in URLs removed.
- The job is a no-op until `MYRMIDON_KNOWLEDGE_EXPORT_REPO` is set; branch and
  interval are tuned by `MYRMIDON_KNOWLEDGE_EXPORT_BRANCH` and
  `MYRMIDON_KNOWLEDGE_EXPORT_INTERVAL_HOURS`.
- Restores #1297 (reverted by #1420/#1423) together with the registry rows for
  the three variables and the updated file list in the module hygiene test.

## changelog-ru

### Модуль знаний, часть L-8: ночной детерминированный экспорт в Git (KNOWLEDGE-2.0 L-8)

- Новые `server/src/myrmidon/knowledge/git-export*.ts`: дерево знаний раз в
  интервал (по умолчанию 24 ч) выгружается в ветку Git-репозитория как
  Markdown, один файл на страницу. Один и тот же набор страниц всегда даёт
  одни и те же байты, поэтому неизменённое дерево не создаёт коммит;
  удалённая страница пропадает из ветки. Раздел `life` из базы не выходит.
  Каждая компания лежит в своём каталоге `<companyId>/` общего репозитория и
  не стирает чужие страницы. Ошибки git пишутся в журнал без учётных данных
  из URL.
- Задание — no-op, пока не задан `MYRMIDON_KNOWLEDGE_EXPORT_REPO`; ветка и
  интервал настраиваются `MYRMIDON_KNOWLEDGE_EXPORT_BRANCH` и
  `MYRMIDON_KNOWLEDGE_EXPORT_INTERVAL_HOURS`.
- Возвращает #1297 (откатан в #1420/#1423) вместе со строками реестра для трёх
  переменных и обновлённым списком файлов в тесте гигиены модуля.

## settings-en

| `MYRMIDON_KNOWLEDGE_EXPORT_REPO` | L-8 | unset (disabled) | Enables the nightly deterministic Git export of the knowledge tree to this repository. | Unset disables export; configure a repository URL explicitly. |
| `MYRMIDON_KNOWLEDGE_EXPORT_BRANCH` | L-8 | `knowledge-export` | Branch used for the exported knowledge snapshot. | Invalid branch names fall back to the default. |
| `MYRMIDON_KNOWLEDGE_EXPORT_INTERVAL_HOURS` | L-8 | `24` | Hours between knowledge export runs. | Values outside 1–168 or non-integers fall back to 24 hours. |

## settings-ru

| `MYRMIDON_KNOWLEDGE_EXPORT_REPO` | L-8 | не задан (выкл) | Включает ночной детерминированный экспорт дерева знаний в этот репозиторий Git. | Если не задан, экспорт выключен; адрес репозитория указывается явно. |
| `MYRMIDON_KNOWLEDGE_EXPORT_BRANCH` | L-8 | `knowledge-export` | Ветка для выгружаемого снимка знаний. | Недопустимое имя ветки заменяется значением по умолчанию. |
| `MYRMIDON_KNOWLEDGE_EXPORT_INTERVAL_HOURS` | L-8 | `24` | Часов между запусками экспорта знаний. | Значения вне 1–168 и нецелые заменяются на 24 часа. |
