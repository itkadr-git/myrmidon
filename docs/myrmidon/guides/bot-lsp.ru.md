# Языковые серверы ботов (BOT-LSP)

> English version: [bot-lsp.md](bot-lsp.md)

Hermes запускает языковой сервер для каждого git worktree, в котором бот правит файлы, чтобы
сообщать диагностику после правки. На TypeScript-монорепозитории это tsserver примерно на 1 ГБ,
а typescript-language-server запускает рядом второй («синтаксический») tsserver; оба живут
`idle_timeout` (по умолчанию 600 с) после последнего обращения. Большинство ботов код не пишут,
а кодящие и так получают проверку типов монорепозитория от сервера сборки, поэтому Myrmidon
выбирает режим языковых серверов для каждого бота.

## Политика

| Бот | Режим по умолчанию |
|---|---|
| Роль (каста) пишет код: `engineer`, `qa`, `devops`, `reviewer`, `release` | `limited` |
| Любая другая роль или роли нет | `off` |

- `off` — `lsp.enabled: false`: ни языкового сервера, ни цикла событий LSP.
- `limited` — один tsserver на worktree (`tsserver.useSyntaxServer: "never"`), без
  автоматической загрузки typings (`disableAutomaticTypingAcquisition`), потолок кучи
  `maxTsServerMemory` 1024 МБ, `idle_timeout` 120 с.
- `full` — собственные значения Hermes (ничего не пишется).

## Где менять

- **Политика инстанса** — Настройки инстанса → General → «Bot language servers»
  (`GET`/`PATCH /api/myrmidon/bot-lsp`): кодящие роли (свои касты тоже), режим для кодящих и
  прочих ролей, простой, потолок памяти и исключённые корни рабочих каталогов. Панель также
  показывает, сколько ботов в каком режиме.
- **Один агент** — раздел «Language servers» карточки агента закрепляет режим
  (`adapterConfig.lsp.mode`); «By role» снимает закрепление.

Рестарт сервера не нужен. Компилятор профиля перечитывает политику на каждом тике сверки;
изменённый блок `lsp` — это изменение `config.yaml`, которое сверка применяет на паузе бота
(тем же путём, что смену модели). Справочник полей — в
[SETTINGS.ru.md](../SETTINGS.ru.md).

## Что получает Hermes

Компилятор пишет блок `lsp` Hermes (`hermes_cli/config_defaults.py`). Настройки tsserver
ограниченного режима идут через `lsp.servers.typescript.initialization_options`, которые Hermes
без изменений передаёт как LSP `initializationOptions` typescript-language-server (id в реестре
— `typescript`):

```yaml
lsp:
  enabled: true
  idle_timeout: 120
  servers:
    typescript:
      initialization_options:
        disableAutomaticTypingAcquisition: true
        maxTsServerMemory: 1024
        tsserver:
          useSyntaxServer: "never"
```

Вход компилятора (`HermesProfileLspSettings`: `enabled`, `idleTimeout`, `excludeRoots`,
`waitMode`, `servers`) принимает и значение по умолчанию инстанса (`instanceDefaults.lsp`),
которое сливается под значением агента; значение агента заполняет политика по ролям.
