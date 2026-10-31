## changelog-en

### Company settings: feedback sharing, responsible user, pause/resume (SETTINGS-UI, OPE-8796)

- Organization settings now expose three fields that already existed in the
  API and the stored company row but had no screen: the feedback data sharing
  switch (`feedbackDataSharingEnabled`; enabling records the consent on the
  server), the default responsible user (`defaultResponsibleUserId`, chosen
  from active company members) and pause/resume of the organization
  (`status` `paused`/`active`), both read from and written through
  `GET`/`PATCH /api/companies/:id`.
- Pause and resume ask for confirmation before the request is sent. Saving
  state, the saved mark and server errors (including a permission refusal)
  are shown inline. Values apply without a restart: the company list is
  refetched after every successful change.

## changelog-ru

### Настройки организации: передача отзывов, ответственный пользователь, пауза/возобновление (SETTINGS-UI, OPE-8796)

- В настройках организации появились три поля, которые уже были в API и в
  хранимой записи компании, но не имели экрана: переключатель передачи
  данных отзывов (`feedbackDataSharingEnabled`; при включении сервер
  фиксирует согласие), ответственный пользователь по умолчанию
  (`defaultResponsibleUserId`, выбор среди активных участников компании) и
  пауза/возобновление организации (`status` `paused`/`active`); значения
  читаются и пишутся через `GET`/`PATCH /api/companies/:id`.
- Пауза и возобновление требуют подтверждения до отправки запроса.
  Состояние сохранения, отметка «Сохранено» и ошибки сервера (в том числе
  отказ по правам) показываются на месте. Изменения применяются без
  перезапуска: после каждого успешного изменения список компаний
  перечитывается.
