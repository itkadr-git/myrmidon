## changelog-en

### Neutralize RFC 2119 keywords line in OMP runner system prompt (1.6.9 OMP-PROMPT-AGY-429)

- Replaces the `RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.` system prompt line in the bundled `@oh-my-pi/pi-coding-agent` CLI with neutral phrasing (`Keywords MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL follow their usual meaning.`) during image builds.
- Prevents Antigravity/Google endpoint 429 quota exhaustion rejections triggered by upstream agent fingerprinting.
- The build step fails fast if the target needle is missing or altered in newer package releases, with automated regression tests in CI.

## changelog-ru

### Нейтрализация строки ключевых слов RFC 2119 в системном тексте OMP (1.6.9 OMP-PROMPT-AGY-429)

- Заменяет строку `RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.` во встроенном системном тексте `@oh-my-pi/pi-coding-agent` на нейтральную формулировку (`Keywords MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL follow their usual meaning.`) на этапе сборки образов раннера.
- Устраняет отказы 429 RESOURCE_EXHAUSTED от Google при обращении агентов omp через пул Antigravity.
- Патч проверяется при сборке (сборка завершается с ошибкой, если исходная строка не найдена или изменилась) и покрыт автоматическими тестами в CI.
