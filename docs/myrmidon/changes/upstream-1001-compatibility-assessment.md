---
divergence-section: Трек 1 — платформа
---

## changelog-en

### Compatibility assessment for Paperclip v2026.1001.0 ideas (1.6.6 planning)

- The five proposed upstream directions were checked against the Myrmidon tree and the
  current release work. The result is a staged adoption plan, not a blind vendor merge:
  - task handoff (upstream #13686) is compatible in principle, but must use the
    Myrmidon CAS handoff contract and preserve existing replay holds, wake guards and
    rollback recovery;
  - atomic native reviewer admission (upstream #13581) is not a direct port because
    Myrmidon already has review-path recovery, execution participants and interaction
    gates. It needs a separate adapter that claims the reviewer run, wake and issue
    lock together, while leaving child ownership unchanged;
  - queued Wait / Steer / Interrupt responses (upstream #13539) are compatible and
    already landed in the server and UI. Interaction receipts remain immutable and do
    not coalesce with comments or other card responses;
  - the channel-connector direction (upstream #13638) is compatible as an incremental
    migration. The connector contract, registry and hub land first, followed by
    observe-mode wiring and one Telegram topic at a time. The vendor chat service
    remains the fallback until each topic is proven;
  - one Myrmidon plugin registration is compatible with the route surface, but must
    preserve the existing mount order and keep pre-auth mounts and startup schedulers
    outside the registry. Connector fail-closed behavior is retained separately.
- The assessment found no schema migration or setting change required by this planning
  step. It records sequencing and compatibility constraints for the implementation PRs.

## changelog-ru

### Проверка совместимости идей Paperclip v2026.1001.0 (план 1.6.6)

- Пять предложенных вендорских направлений сверены с деревом Myrmidon и текущими
  работами выпуска. Итог — поэтапное принятие, а не слепой перенос:
  - передача задачи (вендорский #13686) совместима по смыслу, но должна использовать
    наш CAS-контракт и сохранить существующие replay-hold, guards побудок и защищённый
    откат;
  - атомарный допуск нативного ревьюера (вендорский #13581) не переносится напрямую:
    в Myrmidon уже есть восстановление review-path, execution participants и гейты
    взаимодействий. Нужен отдельный адаптер, который атомарно захватывает ход
    ревьюера, wake и lock задачи, не меняя владельца дочерней задачи;
  - ответы Wait / Steer / Interrupt в очереди (вендорский #13539) совместимы и уже
    вошли в сервер и UI. Receipts взаимодействий неизменяемы и не сливаются с
    комментариями или другими карточками;
  - направление channel connector (вендорский #13638) совместимо с поэтапным
    переносом. Сначала идут контракт, registry и hub, затем observe-mode и по одной
    теме Telegram. Вендорский chat-сервис остаётся запасным путём до проверки каждой
    темы;
  - единая регистрация плагина Myrmidon совместима с набором маршрутов, но должна
    сохранить порядок монтирования, оставить pre-auth mounts и стартовые планировщики
    вне registry. Fail-closed поведение коннекторов сохраняется отдельной правкой.
- Проверка не выявила миграций схемы или новых настроек для этого планового шага.
  Зафиксированы порядок и ограничения совместимости для следующих PR.

## divergence

| 1.6.6-COMPATIBILITY-ASSESSMENT | Проверены пять направлений Paperclip v2026.1001.0 (#13686, #13581, #13539, #13638 и единая регистрация plugin) против текущих CAS, wake/recovery, interaction queue, channel connector и route registry механизмов Myrmidon; зафиксированы совместимые части, необходимые адаптеры и безопасный порядок внедрения. Этот PR меняет только документацию и не меняет поведение | `docs/myrmidon/design/upstream-1001-compatibility.md` и этот change fragment | Нужна явная граница между прямым переносом вендорской идеи и совместимым с Myrmidon поэтапным внедрением; особенно для живых очередей, ревью-путей и горячего chat-сервиса | Документальная проверка: upstream PR descriptions/files, существующие Myrmidon change fragments и design contract; код и настройки не изменены | Удалить строку при следующем release-cut, если плановая оценка больше не нужна; implementation PRs должны заменить её своими divergence rows | (this PR) |
