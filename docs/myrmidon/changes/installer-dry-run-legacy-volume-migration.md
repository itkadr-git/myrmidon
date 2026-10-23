---

---

## changelog-en

### Installer dry-run and safe legacy-volume migration

- `install.sh --dry-run` renders and validates the Compose configuration
  without pulling images or changing running services.
- Normal installs preserve legacy database volumes during migration. New
  install paths use Myrmidon names; uninstall cleanup also recognizes the
  prior volume name for compatibility.

## changelog-ru

### Проверка установщика без изменений и безопасная миграция старых томов

- `install.sh --dry-run` формирует и проверяет конфигурацию Compose, не
  загружая образы и не меняя работающие службы.
- Обычная установка сохраняет унаследованные тома базы при миграции. Для
  новых данных используются имена Myrmidon; очистка также учитывает прежнее
  имя тома для совместимости.
