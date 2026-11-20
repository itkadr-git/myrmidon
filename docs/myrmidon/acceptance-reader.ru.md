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

### Service actor доски (только чтение)

Доска также предоставляет `GET /api/service/issues/{id}/acceptance-scenarios`
на отдельном mTLS listener, не на обычном listener доски. `{id}` — identifier
или UUID задачи. Ответ содержит привязанный к компании снимок, описанный ниже;
при отсутствии acceptance-документа `document` равен `null`.

Задайте `MYRMIDON_ACCEPTANCE_SERVICE_PORT`,
`MYRMIDON_ACCEPTANCE_SERVICE_TLS_KEY_FILE`,
`MYRMIDON_ACCEPTANCE_SERVICE_TLS_CERT_FILE` и
`MYRMIDON_ACCEPTANCE_SERVICE_TLS_CA_FILE`. Необязательный
`MYRMIDON_ACCEPTANCE_SERVICE_HOST` по умолчанию указывает на loopback. Клиент
предъявляет проверенный CA сертификат и соответствующий service bearer; обычные
ключи доски и агента не являются service credentials.

Оператор доски компании выпускает credential через
`POST /api/companies/{companyId}/acceptance-service-credentials` с JSON-полями
`certificateSha256` (64 строчных hex-символа, SHA-256 DER-байтов клиентского
сертификата) и `expiresAt` (будущее ISO-время с часовым поясом). Сервер
фиксирует компанию и audience `acceptance-scenarios`, хранит хеш токена и
возвращает bearer только один раз; храните его безопасно, не в логах,
аргументах команд, репозитории или runner. Отзыв — через
`DELETE /api/companies/{companyId}/acceptance-service-credentials/{id}`.
Выпуск и отзыв аудируются. Просроченный, отозванный, с неверным audience или
несовпадающим сертификатом credential не проходит аутентификацию.

Ответ 200 содержит сильный `ETag` в кавычках, вычисленный из ID задачи, эпохи
и идентичности revision. Сохраните точное значение и передайте его в `If-Match`
при следующем чтении: совпадение должно быть точным; слабые теги, списки и
`*` не считаются совпадением. Изменение снимка даёт 412, неоднозначность — 409,
отсутствующая или чужая задача — 404. Ошибка service-аутентификации даёт 401;
недоверенный сертификат может привести к ошибке TLS handshake.

Этот сервис отличается от экспериментального шлюза и его старого upstream
`/api/issues/{id}/acceptance-scenarios-snapshot`, описанных ниже. Это чтение
на момент запроса, а не атомарная авторизация на внешней границе privileged use.
Нельзя использовать его для включения privileged CI или privileged verdicts.

### Существующий шлюз и upstream

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
