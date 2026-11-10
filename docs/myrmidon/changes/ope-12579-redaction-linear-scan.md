## changelog-en

### OPE-12579: secret masking of run logs no longer stalls the board on long unbroken lines

- The JSON secret-field patterns of `redactSensitiveText` (server/src/redaction.ts) used an unbounded field-name pattern and backtracked quadratically on a long run of name characters (a base64 blob in a run's stdout). On 10.11 a 183 878-character line held the board's event loop for minutes and runs across the fleet lost their controller leases.
- Free-text scans now use a field name that starts only where a word run starts and has bounded name parts: 2 000 000 characters take ~15 ms. Masking results are unchanged; key checks keep the old pattern.

## changelog-ru

### OPE-12579: маскирование секретов в логах прогонов больше не вешает доску на длинной сплошной строке

- Шаблоны поиска секретных полей JSON в `redactSensitiveText` (server/src/redaction.ts) перебирали варианты квадратично на длинной строке без разделителей (base64 в выводе прогона). 10.11 строка в 183 878 символов держала главный поток доски минутами, и прогоны по всему флоту теряли аренду контроллера.
- Поиск по свободному тексту теперь начинает имя поля только в начале слова и ограничивает его длину: 2 000 000 символов — около 15 мс. Результат маскирования прежний; проверка ключей объектов не менялась.
