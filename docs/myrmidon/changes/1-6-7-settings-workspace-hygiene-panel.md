## changelog-en

### Instance → General: the "Workspace hygiene" panel is on the page (1.6.7 SETTINGS-UI, OPE-6249)

- The two disk ceilings of the workspace quota sweep, `workspaceQuotaMb` (one execution workspace) and
  `totalQuotaMb` (the sum of one company's measured workspaces), had a read/write route
  (`GET`/`PATCH /api/myrmidon/workspace-hygiene`) and a finished panel component, but the component was
  never placed on the page, so the production UI had no way to see or change them. The panel "Workspace
  hygiene" now sits on Settings → General next to the bot disk panels. It shows both ceilings, the source
  of each value (default, environment override, saved here), the biggest measured workspaces and the last
  sweep, and saves through the existing `PATCH` route. An empty field means the cap is off.
- A save applies at once: the sweep reads the stored ceilings at the top of every tick, no restart.
- The source labels of the panel went through i18n (they were fixed English strings). A save or a read
  refused with 403 now says "Instance admin rights are required." instead of the raw server text; the
  `PATCH` route stays instance-admin only.
- The merged-workspace cooldown and the stuck-workspace signal delay stay in the Runs & Queue panel; they
  are not part of this one.

## changelog-ru

### Настройки → Общие: на странице появилась панель «Чистота рабочих пространств» (1.6.7 SETTINGS-UI, OPE-6249)

- У двух дисковых пределов проверки рабочих пространств, `workspaceQuotaMb` (одно рабочее пространство
  исполнения) и `totalQuotaMb` (сумма измеренных пространств одной компании), был маршрут чтения и записи
  (`GET`/`PATCH /api/myrmidon/workspace-hygiene`) и готовый компонент панели, но компонент не был
  размещён на странице, поэтому в боевом интерфейсе увидеть и поменять пределы было нельзя. Панель
  «Чистота рабочих пространств» теперь стоит на странице Настройки → Общие рядом с панелями диска ботов.
  Она показывает оба предела, источник каждого значения (по умолчанию, переопределено окружением,
  сохранено здесь), самые большие измеренные пространства и последнюю проверку, а сохраняет через
  существующий маршрут `PATCH`. Пустое поле означает, что ограничения нет.
- Сохранённое значение действует сразу: проверка читает пределы в начале каждого шага, перезапуск не нужен.
- Подписи источников значений в панели переведены через i18n (раньше это были строки на английском).
  Отказ 403 при чтении или сохранении теперь показывается фразой «Нужны права администратора экземпляра.»
  вместо сырого текста сервера; маршрут `PATCH` по-прежнему только для администратора экземпляра.
- Пауза перед удалением слитых пространств и порог сигнала о застрявших пространствах остаются в панели
  «Runs & Queue» и в эту панель не входят.
