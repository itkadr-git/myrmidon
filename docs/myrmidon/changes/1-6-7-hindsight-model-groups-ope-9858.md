# 1.6.7 Hindsight: включить write/summarize/search модели в общий каталог (OPE-9858)

## Контекст и цель
В рамках развития управления моделями и шлюза LiteLLM (OPE-9850, OPE-9464, OPE-9469) три ключевые роли памяти сервиса Hindsight (`write`, `summarize`, `search`) включаются в общий каталог как стандартные группы моделей:
- `hindsight-write`: Запись памяти (retention) — извлечение фактов, сущностей и сохранение долговременных воспоминаний.
- `hindsight-summarize`: Сведение и консолидация памяти (consolidation) — периодическое объединение разрозненных фактов.
- `hindsight-search`: Поиск и воспоминания (recall) — семантический поиск, ранжирование и генерация поисковых запросов.

## Архитектура решения

### 1. Схема конфигурации и персистентность (Shared)
- В `@myrmidon/shared` (`packages/shared/src/myrmidon-agent-memory.ts`) определены типы и Zod-валидаторы:
  - `HINDSIGHT_ROLES = ["write", "summarize", "search"]`
  - `hindsightModelsSchema` и `patchHindsightModelsSchema`
  - Структуры представления `HindsightModelGroupView` и `HindsightModelCatalogView`
  - Константы ограничений API `HINDSIGHT_API_LIMITATIONS`
- Данные сохраняются в `instance_settings.general.agentMemory.hindsightModels` (а также синхронизируются с `writeModel`, `summarizeModel`, `searchModel`).
- Конфигурация перечитывается при каждом обращении, изменения сохраняются без перезапуска сервера Myrmidon.

### 2. Серверный адаптер и маршруты (Server)
- `server/src/myrmidon/agent-memory/hindsight-models-adapter.ts`:
  - `hindsightModelsAdapter`: адаптер для чтения и обновления каталога ролей Hindsight.
  - Двунаправленный маппинг ролей и групп: `hindsightRoleToGroup` и `groupToHindsightRole`.
  - Предоставление дефолтных моделей (`gpt-4o-mini`) при отсутствии сохраненных настроек.
  - Обновление конфигурации без модификации секретов и переменных окружения процесса.
- `server/src/myrmidon/agent-memory/hindsight-models-routes.ts`:
  - `GET /api/myrmidon/hindsight/model-groups` (доступен участникам доски).
  - `PATCH /api/myrmidon/hindsight/model-groups` (доступен администраторам инстанса, валидация через `patchHindsightModelsSchema`).
  - Смонтированы также алиасы под `/api/myrmidon/agent-memory/model-groups` и `/api/myrmidon/companies/:companyId/hindsight/model-groups`.

### 3. Пользовательский интерфейс и отображение групп (Web / UI)
- `ui/src/components/myrmidon/hindsight-models/groupMapping.ts`:
  - Маппинг ролей Hindsight в обобщенные группы каталога моделей (`mapHindsightToCatalogGroups`).
  - Быстрый выбор моделей (suggested models) для каждой роли.
  - Структурированное представление ограничений API (`getHindsightApiLimitations`).
- `ui/src/components/myrmidon/hindsight-models/hindsightModelsApi.ts`:
  - API-клиент и ключи кэша React Query (`hindsightModelGroupsQueryKey`).
- `ui/src/components/myrmidon/hindsight-models/HindsightModelGroupsPanel.tsx`:
  - Панель отображения трех групп моделей ролей памяти.
  - Поля ввода, кнопки быстрого выбора (`gpt-4o-mini`, `claude-3-5-haiku`, `qwen-plus`, `bge-m3`).
  - Баннер ограничений API с явным указанием зависимости от OPE-9469.
  - Сохранение настроек без перезапуска сервера с визуальной индикацией.
- `ui/src/components/myrmidon/model-providers/ModelProvidersScreen.tsx`:
  - Интеграция панели моделей Hindsight в экран «Модели и провайдеры».

## Ограничения API и зависимости
1. **Зависимость от OPE-9469**: Конфигурация ролей сохраняется в базе данных доски без перезапуска. Применение изменений «на лету» в работающий контейнер Hindsight (hot-reload) зависит от реализации API перезагрузки в задаче OPE-9469.
2. **Изоляция секретов**: Интерфейс не модифицирует переменные окружения и не раскрывает секреты. Учетные данные провайдеров управляются через секреты компании.
3. **Совместимость эмбеддингов**: Смена модели поиска (`search`) для существующих банков памяти требует переиндексации, так как векторные пространства разных моделей эмбеддингов несовместимы.
4. **Каталог моделей**: Выбранные модели должны быть доступны через LiteLLM (OPE-9850) или настроенных провайдеров.
5. **Мгновенное применение на доске**: Все запросы сервера считывают свежие настройки без перезапуска Myrmidon.

## Тестирование
- `packages/shared/src/myrmidon-agent-memory.test.ts`: тестирование Zod-схем, нормализации и применения патчей.
- `server/src/myrmidon/agent-memory/hindsight-models-adapter.myrmidon.test.ts`: тестирование адаптера, маппинга ролей, ограничений и изоляции переменных окружения.
- `server/src/myrmidon/agent-memory/hindsight-models-routes.myrmidon.test.ts`: тестирование эндпоинтов GET и PATCH.
- `ui/src/components/myrmidon/hindsight-models/groupMapping.test.ts`: тестирование фронтенд-маппинга и ограничений.
- `ui/src/components/myrmidon/hindsight-models/HindsightModelGroupsPanel.myrmidon.test.tsx`: компонентные тесты рендеринга, редактирования моделей и сохранения.
