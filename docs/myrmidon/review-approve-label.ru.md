# Одобрение ревью -> метка `review-approved`

Ревьюер записывает вердикт на доске. Гейт `hot-files-review` и автослияние читают метку
`review-approved` на pull request. `scripts/myrmidon/review-approve-label.mjs` связывает одно с другим:
одобрение превращается в метку без задержки, руками метку ставить не нужно.

## Правила

Метка ставится, только когда выполнено всё:

1. Последняя строка вердикта по PR от агента-ревьюера — одобрение. Более поздний `RETURN`, `DEFERRED`
   или неясная строка (одобрение и отказ в одной строке, два номера PR в одной строке) отменяет его.
2. PR открыт и не черновик.
3. Голова не менялась после вердикта. Вердикт с головой (`head <sha>`) должен совпасть с текущей
   головой; вердикт без головы должен быть новее коммита головы.
4. Проверка `CI result` коммита головы — `success`.

PR, у которого голова сменилась после одобрения, попадает в отчёт как `needs-rereview`: ревьюер смотрит
только новые коммиты. Скрипт такой PR не метит. Новый push сам снимает метку (`hot-files-review`).

## Строки вердикта

`VERDICT #123: APPROVE`, `VERDICT: APPROVE - PR #123, head <sha>`,
`VERDICT owner/name#123: APPROVE (head <sha>)`. Отказ — `RETURN`, `REWORK`, `DEFERRED`,
`CHANGES REQUESTED`. Ревьюеры — агенты доски, имя которых подходит под `--reviewer-pattern`
(по умолчанию `^adm-dev-review`).

## Запуск

```sh
# каждые 5-10 минут на хосте оператора (GH_TOKEN должен уметь править метки)
node scripts/myrmidon/review-approve-label.mjs --repo itkadr-git/myrmidon \
  --psql-cmd 'sudo docker exec -i myrmidon-pg psql -U postgres -d paperclip -At'
# пробный прогон без записи
node scripts/myrmidon/review-approve-label.mjs --repo itkadr-git/myrmidon --psql-cmd '...' --dry-run
# SQL, который уходит в базу доски (комментарии с вердиктами за 48 часов)
node scripts/myrmidon/review-approve-label.mjs --print-sql
```

SQL уходит команде на stdin. `--verdicts <file.json>` читает вместо этого JSON-массив
`{id, issueId, createdAt, authorName, body}`. Код выхода: 0 — ок, 1 — сбой вызова доски или GitHub,
2 — ошибка запуска. Токен не печатается.

Тест: `node --test scripts/myrmidon/review-approve-label.test.mjs`.
