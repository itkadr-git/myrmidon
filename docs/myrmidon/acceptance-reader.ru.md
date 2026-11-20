# Acceptance reader

> English version: [acceptance-reader.md](acceptance-reader.md)

Узкий шлюз с привязкой к компании между недоверенным CI-runner и доской
Myrmidon, построенный для проверки acceptance-сценариев. Код:
`scripts/myrmidon/privileged-ci/acceptance-reader/`; upstream read model:
`server/src/services/issue-acceptance-snapshot.ts` и
`server/src/routes/issue-acceptance-snapshot.ts`; миграции:
`packages/db/src/migrations/0489_complete_aqueduct.sql` (триггеры эпох).

## Статус

Экспериментальный черновик. Не пригоден к развёртыванию, production-ключи не
выпускались, и privileged CI нельзя включать на этом компоненте, пока не
выполнены все предпосылки ниже. Авторитетный контракт компонента, модель
угроз и fixture-проверка живут в экспериментальном
[README acceptance-reader](../../scripts/myrmidon/privileged-ci/acceptance-reader/README.md).

## Что делает

- Доска отдаёт один MVCC-снимок на запрос:
  `GET /api/issues/{id}/acceptance-scenarios-snapshot` возвращает минимальную
  идентичность issue (`id`, `identifier`, `companyId`, `version`) и документ
  `acceptance-scenarios` (`id`, `latestRevisionId`,
  `latestRevisionNumber`, `body`) одним соединённым SELECT; чужой и
  отсутствующий issue дают идентичный 404.
- `issue.version` — монотонная эпоха issue в `issue_acceptance_epochs`,
  инкрементируемая триггерами БД при каждой релевантной мутации (строка
  issue, строка acceptance-link с обеих сторон переноса, привязанный
  документ, строки revision). Прямой сброс, удаление строки и TRUNCATE
  отклоняются; эпоха передаётся десятичной строкой bigint.
- Шлюз отдаёт один pin-route и одну серверную условную проверку (verify).
  Verify валидирует ограниченное тело запроса до свежего upstream-чтения и
  отвечает 200/409/400/401/502.

## Операторская поверхность

Запуск и выдача записей — строго по экспериментальному README
(JSON-конфигурация, персистентные записи credential, ротация, audit-файл,
mTLS-файлы upstream). Секреты не размещать в репозитории, аргументах
команд, логах и runner; обычный board agent key не использовать.

## Предпосылки до любого реального использования

- Сетевая политика, запрещающая runner прямой доступ к доске.
- Живой прогон acceptance через mTLS-upstream и negative-проверки с
  реальными credentials.
- Путь выдачи run-scoped credential на одну CI-job (ведётся отдельно;
  общий bearer не связывает запросы с одной job).
- Независимый security review.

Пока всё это не выполнено, считать шлюз fixture-tested черновиком и держать
privileged CI выключенным.
