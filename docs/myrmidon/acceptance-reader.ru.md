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

Этот сервис — выделенный upstream экспериментального шлюза. Это чтение
на момент запроса, а не атомарная авторизация на внешней границе privileged use.
Нельзя использовать его для включения privileged CI или privileged verdicts.

### Операторский регламент privileged finalization

**Не включайте privileged finalization и GitHub verdict до независимого security review и отдельного согласованного rollout.** Описание интерфейса не разрешает его развёртывание. Внешнее действие GitHub не атомарно с решением в БД.

1. Оператор доски компании выпускает отдельный write credential через `POST /api/companies/{companyId}/native-finalization-service-credentials`: JSON `certificateSha256` (строчный SHA-256 DER клиентского сертификата) и будущий `expiresAt` (ISO с часовым поясом). Bearer возвращается один раз; защищайте его и приватный ключ, не пишите в логи. Audience `native-finalization-submit` отделён от read-only `acceptance-scenarios`; credentials не взаимозаменяемы. Используется тот же проверенный mTLS listener.
2. Для одного run оператор вызывает `POST /api/companies/{companyId}/native-finalization-grants`: UUID `issueId`, `runId`, `principalId`, `credentialId` и будущее ISO-время `notAfter`. Run, issue и credential принадлежат компании; координатор должен быть свободен. Grant привязывает principal, сертификат и credential к run; под блокировкой координатора устанавливается service-required авторизация.
3. Прочитайте snapshot read credential. Вызовите `POST /api/service/native-runs/{runId}/finalization-requests` с write bearer и его клиентским сертификатом, точным сильным `If-Match`, заголовком `Idempotency-Key` (1–128 печатных ASCII-символов) и JSON `documentId`, `expectedRevisionId`, `expectedIssueEpoch` из snapshot. Ответ 202 содержит `requestId` и `statusUrl`. Повтор того же ключа и тела возвращает прежнюю квитанцию; другой payload с тем же ключом или другой активный запрос даёт 409. После 412 перечитайте snapshot.
4. Прочитайте `statusUrl` теми же write credential и сертификатом: состояния `accepted`, `processing`, `committed` (с `decisionId`), `rejected` (с `errorCode`). Recovery ждёт успешный workspace-finalize, выдаёт ограниченную по времени lease и забирает брошенную работу после истечения. Старый worker не завершит чужую lease. Временные ошибки и deadlock повторяются; изменённый snapshot либо истёкшая/отозванная авторизация приводят к атомарному отказу и потреблению outbox. После отказа по snapshot прочитайте новый snapshot и отправьте новый ключ при действующем grant. Отдельная lease координатора неудачного finalizer может удерживаться до истечения. Отозванный или истёкший credential не читает статус; авторизованный оператор проверяет записи компании и audit.
5. Отзовите write credential через `DELETE /api/companies/{companyId}/native-finalization-service-credentials/{id}` с авторизацией оператора. Выпуск, отзыв и выдача grant записываются как события `native_finalization_service_credential.issued`, `native_finalization_service_credential.revoked`, `native_finalization_grant.issued`. API отзыва grant здесь нет; для запрета дальнейшего использования отзовите credential. Проверяйте request/outbox и audit без раскрытия bearer.

### Шлюз и upstream

- Сервис отдаёт один MVCC-снимок на запрос:
  `GET /api/service/issues/{id}/acceptance-scenarios` возвращает внутреннюю
  идентичность issue (`id`, `identifier`, `companyId`, `version`) и документ
  `acceptance-scenarios` (`id`, `latestRevisionId`,
  `latestRevisionNumber`, `body`) одним соединённым SELECT; чужой и
  отсутствующий issue дают идентичный 404.
- `issue.version` — монотонная эпоха issue в `issue_acceptance_epochs`,
  инкрементируемая триггерами БД при каждой релевантной мутации (строка
  issue, строка acceptance-link с обеих сторон переноса, привязанный
  документ, строки revision). Прямой сброс, удаление строки и TRUNCATE
  отклоняются; эпоха передаётся десятичной строкой bigint.
- Шлюз предоставляет только `GET /api/issues/{id}/acceptance-snapshot`.
  Публичная проекция issue содержит ровно `identifier` и `companyId`, документа —
  ровно `id`, `latestRevisionId`, `body` (или null). Сильный `ETag` передаётся
  в `If-Match`; изменившийся снимок возвращает 412.

## Операторская поверхность

Запуск и выдача записей — строго по экспериментальному README
(JSON-конфигурация, персистентные записи credential, ротация, audit-файл,
mTLS-файлы upstream). `upstream.tokenFile` содержит отдельный привязанный к
сертификату service bearer, отличный от bearer runner. Секреты не размещать в репозитории, аргументах
команд, логах и runner; обычный board agent key не использовать.

## Предпосылки до любого реального использования

- Сетевая политика, запрещающая runner прямой доступ к доске. В OPE-15287
  пройден тест временной HTTP-топологии: шлюз доступен, прямой DNS к core не
  разрешается, прямой IP даёт timeout. Это не доказательство production или mTLS.
- Живой прогон acceptance через mTLS-upstream и negative-проверки с
  реальными credentials.
- Путь выдачи run-scoped credential на одну CI-job (ведётся отдельно;
  общий bearer не связывает запросы с одной job).
- Независимый security review.

Пока всё это не выполнено, считать шлюз fixture-tested черновиком и держать
privileged CI выключенным.
