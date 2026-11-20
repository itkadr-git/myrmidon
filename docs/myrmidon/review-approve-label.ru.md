# Одобрение ревью -> метка `review-approved`

Ревьюер записывает вердикт на доске. Гейт `hot-files-review` и автослияние читают метку
`review-approved` на pull request. `scripts/myrmidon/review-approve-label.mjs` связывает одно с другим:
одобрение превращается в метку без задержки, руками метку ставить не нужно.

## Правила

Метка ставится, только когда выполнено всё:

1. Ветка `main` зелёная: проверка `CI result` коммита головы `main` имеет статус `success`.
   Если последний завершённый `CI result` красный (`failure`, `cancelled`, `timed_out`), автовливание
   останавливается (`action: "hold"`, `reason: "main-red"`), а при `failure` растёт экспоненциальная
   пауза (backoff). При текущем `in_progress` или `queued` статус берётся по предыдущему завершённому `CI result`,
   чтобы очередь CI не блокировала конвейер. При этом метка `review-approved` продолжает ставиться для
   одобренных PR с зелёным CI — блокируется только автовливание. Как только `main` снова зеленеет —
   вливание автоматически возобновляется, счётчик backoff сбрасывается.
2. Последняя строка вердикта по PR от агента-ревьюера — одобрение. Более поздний `RETURN`, `DEFERRED`
   или неясная строка (одобрение и отказ в одной строке, два номера PR в одной строке) отменяет его.
3. PR открыт и не черновик.
4. Голова не менялась после вердикта. Вердикт с головой (`head <sha>`) должен совпасть с текущей
   головой; вердикт без головы должен быть новее коммита головы.
5. Проверка `CI result` коммита головы — `success`.

PR, у которого голова сменилась после одобрения, попадает в отчёт как `needs-rereview`: ревьюер смотрит
только новые коммиты. Скрипт такой PR не метит. Новый push сам снимает метку (`hot-files-review`).
Повторная обработка безопасна и идемпотентна: при уже проставленной метке и включённом автослиянии
скрипт возвращает `noop` без лишних вызовов API.

## Строки вердикта

`VERDICT #123: APPROVE`, `VERDICT: APPROVE - PR #123, head <sha>`,
`VERDICT owner/name#123: APPROVE (head <sha>)`. Отказ — `RETURN`, `REWORK`, `DEFERRED`,
`CHANGES REQUESTED`. Ревьюеры — агенты доски, имя которых подходит под `--reviewer-pattern`
(по умолчанию `^adm-dev-review`).

## Запуск

```sh
# каждые 5-10 минут на хосте оператора (GH_TOKEN должен уметь править метки и включать merge)
node scripts/myrmidon/review-approve-label.mjs --repo itkadr-git/myrmidon \
  --psql-cmd 'sudo docker exec -i myrmidon-pg psql -U postgres -d paperclip -At' \
  --auto-merge --state-file /var/run/myrmidon/automerge-state.json
# пробный прогон без записи
node scripts/myrmidon/review-approve-label.mjs --repo itkadr-git/myrmidon --psql-cmd '...' --dry-run
# SQL, который уходит в базу доски (комментарии с вердиктами за 48 часов)
node scripts/myrmidon/review-approve-label.mjs --print-sql
```

SQL уходит команде на stdin. `--verdicts <file.json>` читает вместо этого JSON-массив
`{id, issueId, createdAt, authorName, body}`. Код выхода: 0 — ок, 1 — сбой вызова доски или GitHub,
2 — ошибка запуска. Токен не печатается.

Тест: `node --test scripts/myrmidon/review-approve-label.test.mjs`.

## Нативная проверка `Board review` и право `checks:write`

Кроме метки, доска записывает формальное ревью в GitHub как check run с именем
`Board review` на коммите головы PR (`server/src/services/pull-request-approval-propagation.ts`):
`success` после одобрения, `failure` после отказа. Проверка делает вердикт видимым
в интерфейсе проверок GitHub без открытия доски. Источник истины — вердикт на доске;
check run — его проекция.

Для записи этой проверки установка GitHub App (или токен, которым пользуется оператор)
должна иметь право `checks:write`. Без него GitHub отвечает `403`, доска пишет warn,
и проверка не появляется — конвейер меток при этом не страдает.

Прежде чем полагаться на проверку, пробуй право:

```sh
GH_TOKEN=... node scripts/myrmidon/review-check-run-probe.mjs --repo itkadr-git/myrmidon --ref <ветка-или-sha>
```

Проба разрешает голову ветки, создаёт один check run с именем `Board review probe`
(никогда не продуктовое имя `Board review`), сразу `completed` с заключением `neutral`,
и печатает `ok` с номером check run. При отказе печатает понятный текст: `403` ->
«нет права checks:write — нужна задача оператору доски» (код 1), `404` — репозиторий
или ветка не найдены, `401` — токен не принят. Код выхода 0 только при успехе.
Токен не печатается.

Включение `checks:write` — правка боевых настроек GitHub App. Её делает оператор доски
по отдельной задаче; в репозитории нет правок настроек App или compose-образа доски
(доска запускается только из образа CI).

Тест: `node --test scripts/myrmidon/review-check-run-probe.test.mjs`.
