## Руководства

Подробные руководства из [`docs/myrmidon/guides`](https://github.com/itkadr-git/myrmidon/tree/main/docs/myrmidon/guides) в репозитории, сгруппированные по разделам продукта. Каждое руководство доступно прямо в этой вики как самостоятельная страница.

### Агенты и касты

- [Агенты-акторы с грантами прав: окружения и tool-подключения](Actor-grant-routes.ru)

- [Администратор доски: переключатель в карточке агента и страница прав](Agent-board-admin.ru)

- [Память агента: вкладка Memory в карточке агента](Agent-memory-card.ru)

- [Инструкции агента: история ревизий и откат](Agent-instructions-revisions.ru)

- [Комната обсуждения на карточке задачи (1.7 AGENT-EXCHANGE-A)](Agent-exchange.ru)

- [Обмены агентов: лента обсуждений для владельца](Agent-exchange-feed.ru)

- [Свои касты — справочник ролей агентов компании](Custom-castes.ru)

- [Асимметричные дебаты: генератор, критик и судья вне спора (1.7 DEBATE-ASYM A)](Debate-asym.ru)

- [Дебаты по кастам и кнопка «Обсудить» на задаче касты (1.7 DEBATE-ASYM B)](Debate-asym-castes.ru)

- [Настройки роя (самоорганизации)](Swarm-claim-settings.ru)

- [Самоорганизация: касты, гнёзда, феромоны](Swarm-self-organization.ru)

- [Параллельные помощники](Parallel-helpers.ru)

- [Страницы архитектуры агентов и исполнения](Agent-execution-architecture.ru)

- [Флот агентов в UI-2](Ui2-agents-fleet.ru)



### Задачи и доска

- [Умолчания списка задач для агентов (1.6.5 F-16, часть A)](Issue-list-agent-defaults.ru)

- [Задача закрывается сама, когда её пулл-реквесты слиты (TASK-PR-SYNC)](Task-pr-sync.ru)

- [Лимит WIP: лимит задач в работе на агента](Wip-limit.ru)

- [Экран «Чат с Полководцем»: планирование свободным текстом в портале (CTO-CHAT A)](Commander-chat.ru)

- [Планировщик чата с доской: текст владельца в предложенный эпик (CTO-CHAT B)](Cto-chat-planner.ru)



### Telegram и каналы

- [Поля Telegram на карточке агента](Agent-telegram-card.ru)

- [Список допущенных каналов — кто может писать ботам](Channel-allowlist.ru)

- [Настройка и проверка чат-эндпоинта](Chat-endpoint-setup.ru)

- [Карточки вопросов и согласований агентов доставляются владельцу в Telegram](Owner-telegram-cards.ru)

- [Активный канал владельца: доклады следуют за владельцем между порталом и Telegram (1.7-ACTIVE-CHANNEL)](Owner-active-channel.ru)

- [Команды Telegram для принятия/отклонения планов](Telegram-accept-reject.ru)

- [Мостовой Telegram-чат: адресация любого агента компании через @<alias>](Telegram-alias-addressing.ru)

- [Telegram-мост: служебные тексты по языку пользователя (TG-LOCALE)](Telegram-bridge-locale.ru)

- [Telegram-личка: редактируемый статус прогона и инлайн-деление длинных ответов](Telegram-dm-status.ru)

- [Адресация агентов из одного Telegram-чата](Telegram-multi-agent.ru)

- [Топики Telegram-группы как входящие задач (topic inbound)](Telegram-topic-inbound.ru)

- [Дедупликация событий и webhook-карточек взаимодействий](Interaction-webhook-dedupe.ru)

- [CTO-CHAT: Команда /plan в Telegram](Cto-chat-telegram-plan.ru)

- [Сухой прогон переадресации интеракций](Readdress-report.ru)

- [Уведомления владельцу о событиях обновления (TG-NOTIFY)](Owner-update-notifications.ru)



### Модели, ключи и трейсинг

- [Провайдеры моделей компании (реестр, ключи write-only, кэш моделей)](Model-providers.ru)

- [LLM-трейсинг: как устроен конвейер, где лежат данные, как проверить (TRACING-HEALTH)](Tracing.ru)

- [Здоровье LLM-трейсинга: карточка статуса и сигнал оператору (TRACING-HEALTH)](Tracing-health.ru)



### Знания, обучение и качество

- [Фуражировка: сбор знаний из одобренных источников (1.6 FORAGING)](Foraging.ru)

- [База знаний (KNOWLEDGE-2.0, 1.6.6)](Knowledge.ru)

- [Импорт корпуса из RAGFlow](Corpus-ragflow-import.ru)

- [MCP-инструменты корпуса для ботов доски](Corpus-mcp-tools.ru)

- [Метрики knowledge-on-change (KNOWLEDGE-ON-CHANGE, 1.6.6)](Knowledge-on-change-metrics.ru)

- [Регламенты компании в вики (черновик → одобрено, ревизии, откат)](Wiki-regulations.ru)

- [Гейт простоя фуражировки (myrmidon 1.6.3 FORAGING-IDLE-GATE)](Foraging-idle-gate.ru)

- [Руководство по миграции знаний ADM (OPE-9263)](Adm-knowledge-migration.ru)

- [Эталоны и судья: путь оценки качества (1.6 EVALS-A)](Reference-task-evals.ru)

- [Эталонные оценки: судья из другого семейства моделей](Evals-judge-family-selection.ru)

- [Сравнение с базовой линией на экране Quality](Baseline-comparison.ru)

- [API снимков базовой линии](Baseline-snapshots-api.ru)



### Автономия и ограждения

- [Матрица автономии: точки исполнения](Autonomy-matrix.ru)

- [AUTONOMY-MATRIX: Удержание действий для одобрения](Autonomy-matrix-holding-actions.ru)

- [Матрица автономии: Контроль изменения инструкций](Autonomy-matrix-instructions.ru)

- [Матрица автономии в шлюзе инструментов](Autonomy-matrix-tool-gateway.ru)

- [Контроль действия DELETE в матрице автономии](Autonomy-delete-enforcement.ru)

- [Матрица автономии: класс действия `deploy`](Autonomy-deploy-merge.ru)

- [Матрица автономии — принудительное применение на паузе, возобновлении и побудке](Autonomy-pause-wake-enforcement.ru)

- [Режимы применения ограждений, настройки и журнал UI](Guardrails-modes-settings.ru)

- [Ограничения и редактирование вывода guardrail](Guardrails-run-output.ru)

- [GUARDRAILS: проверка ложных срабатываний на эталонном корпусе в CI](Guardrails-ci-corpus.ru)

- [Режимы маскирования](Redaction-modes.ru)

- [Аварийная остановка прогонов осушаемой паузы](Emergency-stop.ru)

- [Автоматическое возобновление агента из `error` (AUTO-RESUME)](Auto-resume.ru)

- [Обнаружение зависших прогонов (живость прогона по прогрессу)](Run-stall.ru)

- [Сигнал о застрявшем queued-прогоне (F-09)](Queued-run-stall.ru)

- [Исправление проблемы WAKE-STALL-ROOT B](Fix-wake-stall-root-b.ru)

- [Сервис воскрешения побудок](Wake-resurrection-service.ru)

- [Сторож мёртвых блоков (stale-block)](Stale-block.ru)

- [Гард контекста долгой задачи (1.6.6 LONG-TASK-CONTEXT)](Long-task-context.ru)

- [Лимиты допуска прогонов](Run-limits.ru)

- [Политика выполнения и настройки ленты внимания (1.6.6 SETTINGS-UI S)](Instance-execution-policy-and-attention.ru)

- [Соответствие маршрутов DELETE матрице автономности](Delete-route-mapping.ru)



### Бюджеты и лимиты расхода

- [Исполнение лимитов расхода: сигнал, мягкая пауза или жёсткий отказ (1.7 BUDGET-CONFIG B)](Budget-enforcement.ru)

- [Лимиты расхода по уровням иерархии (1.7 BUDGET-CONFIG)](Budget-limits.ru)

- [Лимиты расхода по уровням: экран владельца (1.7 BUDGET-CONFIG D)](Budget-limits-ui.ru)

- [Проекция бюджетов LiteLLM (BUDGET-CONFIG C)](Litellm-budget-projection.ru)

- [Бюджеты LiteLLM-ключей](Litellm-key-budgets.ru)

- [Оверлей потокового учёта стоимости LiteLLM v1.104.1](Litellm-streaming-cost-overlay.ru)

- [Рекомендации по бюджету промпта и глубокий разбор](Prompt-budget-advice.ru)



### Коннекторы и инструменты

- [Хаб доступов (Access hub)](Access-hub.ru)

- [Коннектор alibaba-image: бесплатная генерация и правка изображений для агентов](Alibaba-image-connector.ru)

- [Руководство владельца коннектора Google AI](Google-ai-connector.ru)

- [Облака: облачное хранилище через коннектор](Cloud-connector.ru)

- [Файлы и почта Microsoft 365 для ботов-контейнеров](Cloud-files-connector.ru)

- [Внешние MCP-коннекторы: подключение без кода форка](External-mcp-connectors.ru)

- [Панель коннекторов: сопряжение, политика подписи и журнал](Connector-panel.ru)

- [Браузерный мост: шлюз коннекторов клиента и сопряжение](Browser-bridge-gateway.ru)

- [Расширение браузерного моста (части C и D)](Bridge-extension.ru)

- [Контракт хелпера подписи (native messaging)](Signing-host-contract.ru)

- [Политика кэширования и предохранителя учетных данных GitHub (1.6.6 OPE-9997, 1.6.7 OPE-12446)](Github-credentials-cache.ru)

- [Авторизоваться в GitHub один раз на весь сервер через своё GitHub App (GITHUB-SHARED-IDENTITY)](Github-shared-identity.ru)

- [Справочник runtime возможностей (capabilities) плагинов](Plugin-capabilities.ru)

- [Ключи плагинов](Plugin-entitlement-keys.ru)



### Обслуживание сервера

- [Мониторинг нагрузки API и алерты задержки (1.6.6 OPE-9997)](Api-load-monitoring.ru)

- [Политика обновления доски: окно обслуживания, режим, канарейка парка](Auto-update-window-canary.ru)

- [Канарейка capacity policy](Capacity-policy-canary.ru)

- [Компоновщик порядка кандидатов capacity policy](Capacity-policy-composer.ru)

- [Данные дашборда флота: подключения VictoriaMetrics + Zabbix, API снимка, самопроверка (1.6.6 MONITORING C)](Fleet-dashboard-monitoring.ru)

- [Консоль серверов](Server-console.ru)

- [Экран «Серверы» в UI2 (/fleet)](Ui2-servers.ru)

- [Оболочка Myrmidon 2.0 за `enableMyrmidonUi2` (UI 2.0)](Ui2-shell.ru)

- [Instance → Features: что работает и работает ли (FEATURES)](Features-page.ru)

- [Пользователи инстанса (Instance users)](Instance-users.ru)

- [Управление пользователями и журнал аудита (users-admin-a)](Users-admin-a.ru)

- [Экран управления пользователями компании (1.7 USERS-ADMIN-UI B)](Users-admin-ui.ru)

- [Баннер обслуживания](Maintenance-banner.ru)

- [Очистка рабочих копий после слияния](Workspace-cleanup.ru)

- [Чекпоинты turn'ов рабочих областей](Workspace-turn-checkpoints.ru)

- [Хранение резервных копий базы данных](Backup-retention.ru)

- [Автооткат по здоровью после выката](Deploy-auto-rollback.ru)

- [Повторы при deployment cooldown и HTTP 429 (ограниченный бэкофф и подавление немедленных пробуждений)](Deployment-cooldown-retries.ru)

- [Удалённые площадки исполнения: контракт site-agent и руководство оператора](Remote-execution-sites.ru)

- [Стенд-сценарий: убить шлюз посреди прогона](Team-liveness-stand-scenario.ru)

- [Контейнер бота: раздел «Container» карточки агента](Bot-container-card.ru)

- [Языковые серверы ботов (BOT-LSP)](Bot-lsp.ru)

- [Путь OCR: PDF в текст в workspace бота](Ocr.ru)

- [Браузеры: экран живого браузера](Browsers.ru)

- [Имена переменных окружения: MYRMIDON_* с алиасом PAPERCLIP_*](Env-names-alias.ru)

- [API загрузки и валидации пользовательских каталогов локализации](Locale-upload.ru)



### Выпуски и брендинг

- [Имя продукта в документации](Docs-branding.ru)

- [Брендинг продукта в интерфейсе (B1a)](Ui-product-branding.ru)

- [Ребренд B: тексты сервера, установщик, вывод CLI, сообщения API](Rebrand-b-server-texts.ru)

- [Имя вендора в сборке (REBRAND F)](Rebrand-vendor-name.ru)

- [Ребренд D: MCP-инструменты доски называются `myrmidon*`, старые имена — алиасы](Mcp-tool-names.ru)

- [Знак во вкладке и на домашнем экране (FAVICON)](Favicon.ru)

- [Доля вендорного кода в репозитории](Vendor-share-analysis.ru)

- [Доля vendor-производных файлов в заметках релиза (VENDOR-SHARE-METRIC, 1.6.5)](Vendor-share-release-metric.ru)

- [Проверка брендинга перед релизом (только чтение)](Brand-release-check.ru)

- [OPE-9335: идентичность онбординга и обновление сохранённых инструкций](Onboarding-identity-refresh.ru)

- [Лицензирование закрытых модулей](Licensing.ru)

- [Реестр стека](Stack-registry.ru)

- [Одобрение возможностей при обновлении плагина](Plugin-upgrade-approvals.ru)
