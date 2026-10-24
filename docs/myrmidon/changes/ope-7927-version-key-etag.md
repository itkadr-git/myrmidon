## changelog-en

### Agent list and live-run validators follow the authorized response

- The company agent list checks company authorization and filters rows by agent-read access before response construction. Its ETag includes the authorized scope, configuration-redaction decision, and visible response rows.
- The live-runs endpoint checks telemetry access and redacts run data before deriving its ETag; authorization context and redacted rows are part of the response variant.
- The Agents pages refresh live-run data every 60 seconds (previously 15 seconds).
- Validation: route regressions exercise the same `If-None-Match` across changed agent visibility and run redaction. Validators intentionally over-invalidate when authorization or redaction context changes.

## changelog-ru

### Валидаторы списка агентов и живых прогонов учитывают ответ с текущими правами

- Список агентов компании сначала проверяет доступ к компании и отбирает строки по праву чтения агентов. ETag включает область доступа, решение об ограничении конфигурации и видимые строки ответа.
- Конечная точка живых прогонов проверяет доступ к телеметрии и редактирует данные до вычисления ETag; контекст доступа и отредактированные строки входят в вариант ответа.
- Страницы Agents обновляют данные живых прогонов раз в 60 секунд вместо прежних 15.
- Проверка: регрессионные тесты маршрутов повторно используют прежний `If-None-Match` после изменения видимости агента и редактирования данных прогона. Validator намеренно инвалидируется при изменении контекста авторизации или редактирования.
