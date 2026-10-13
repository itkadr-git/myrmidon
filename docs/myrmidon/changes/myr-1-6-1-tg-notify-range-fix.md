## changelog-en

### Telegram notify: one rarelyMaxPerDay range (TG-NOTIFY)

- The `rarelyMaxPerDay` range is now single: 1-50, the merged proactivity contract. The
  settings schema, the stored-document parser and the panel input all enforce it; an
  out-of-range stored value falls back to the default of 3.

## changelog-ru

### Telegram-уведомления: один диапазон rarelyMaxPerDay (TG-NOTIFY)

- Диапазон `rarelyMaxPerDay` теперь один: 1-50, как во влитом контракте проактивности.
  Схема настроек, парсер сохранённого документа и поле ввода панели соблюдают его;
  значение вне диапазона в хранилище заменяется умолчанием 3.
