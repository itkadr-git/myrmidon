## changelog-en

### Adapters: add omp-local adapter for Oh My Pi runtime (OMP-LOCAL)

- Added independent local adapter `omp-local` (`adapterType: "omp_local"`, package `@myrmidonai/adapter-omp-local`) for the Oh My Pi (`omp`) runtime, pinned to `@oh-my-pi/pi-coding-agent@18.9.2`.
- Implemented first-turn isolated session allocation in `~/.omp/paperclips/<companyId>/<agentId>` and turn resumption via session header validation without altering `pi-local` behavior.
- Supported custom model providers via deterministic `models.yml` generation from `PAPERCLIP_OMP_PROVIDERS` (falling back to `PAPERCLIP_PI_PROVIDERS`) and `omp models ls` model discovery.
- Materialized runtime skills into managed skills directories without `--skill` CLI flags, including remote execution staging under `<agentConfig>/skills`.
- Added allowlisted model provider credential environment variables (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`) for `omp_local` runs.
- Registered adapter across server, CLI, and UI registries with full capability declarations and environment diagnostic probes.

## changelog-ru

### Адаптеры: самостоятельный адаптер omp-local для среды Oh My Pi (OMP-LOCAL)

- Добавлен независимый локальный адаптер `omp-local` (`adapterType: "omp_local"`, пакет `@myrmidonai/adapter-omp-local`) для среды Oh My Pi (`omp`), зафиксированный на версии `@oh-my-pi/pi-coding-agent@18.9.2`.
- Реализовано создание сессий в изолированном каталоге `~/.omp/paperclips/<companyId>/<agentId>` на первом ходе и возобновление сессий с проверкой заголовка и cwd на последующих ходах без изменения поведения `pi-local`.
- Поддержана настройка провайдеров моделей через генерацию `models.yml` из `PAPERCLIP_OMP_PROVIDERS` (с фолбэком на `PAPERCLIP_PI_PROVIDERS`) и обнаружение моделей через `omp models ls`.
- Реализована материализация рантайм-скилов в управляемый каталог скилов без передачи флага `--skill`, включая стейджинг скилов в `<agentConfig>/skills` для удаленного запуска.
- В список разрешенных переменных окружения провайдеров моделей для `omp_local` включены ключи `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` и `XAI_API_KEY`.
- Адаптер зарегистрирован в реестрах server, CLI и UI с полным объявлением возможностей и диагностикой окружения.
