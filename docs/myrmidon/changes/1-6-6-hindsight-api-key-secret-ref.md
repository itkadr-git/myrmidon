## changelog-en

### Hindsight plugin: API key field is a secret reference (SETTINGS-UI, OPE-6249)

- `hindsightApiKeyRef` in the Hindsight plugin settings is now declared as a
  `secret-ref` field, so the settings screen offers the secret picker instead
  of a plain text box.

## changelog-ru

### Плагин Hindsight: ключ API — ссылка на секрет (SETTINGS-UI, OPE-6249)

- Поле `hindsightApiKeyRef` в настройках плагина Hindsight объявлено как
  `secret-ref`: в интерфейсе настроек выбирается секрет из хранилища, а не
  вводится обычный текст.
