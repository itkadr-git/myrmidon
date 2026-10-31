# Чек-лист smoke-проверки OOMKilled и лимитов памяти ботов (1.6.6 / OPE-8425)

## 1. Назначение и цель

После выравнивания cgroup-лимитов памяти ботов флота (переход с 4GiB на 1GiB в рамках 1.6.6 T4 / OPE-7771 / OPE-8418) данный регламент и утилита обеспечивают **воспроизводимую, строго read-only проверку** фактических лимитов памяти контейнеров и отсутствия аварийных завершений по нехватке памяти (`State.OOMKilled`).

### Гарантия неизменяемости (Read-Only Invariant)
- **ЗАПРЕЩЕНО** выполнять `docker restart`, `docker stop`, `docker rm`, `docker run`, `docker create`, `docker update`.
- **ЗАПРЕЩЕНО** отправлять модифицирующие HTTP-запросы (`PATCH`, `POST /apply` и др.).
- Проверка выполняется исключительно в режиме чтения: `docker inspect`, `docker ps` или через статический дамп inspect JSON.

---

## 2. Критерии приёмки

| Критерий | Требование | Метод проверки | Порог отказа |
|---|---|---|---|
| **Статус OOMKilled** | `State.OOMKilled == false` | Поле inspect контейнера Docker | Наличие хотя бы одного бота с `true` |
| **Фактический лимит памяти** | `HostConfig.Memory == targetMemoryBytes` | 1024 MiB (1 073 741 824 B) для стандартных<br>1536 MiB (1 610 612 736 B) для горячих | Расхождение со значением или `0` (unlimited) |
| **Состояние контейнера** | `State.Running == true` | Проверка для всех активных ботов | Неожиданно отсутствующий или упавший контейнер |
| **Безопасность ёмкости хоста** | Сумма лимитов флота < 68 GiB RAM | `65 536 MiB` (64.00 GiB) на 63 бота | Суммарные лимиты превышают RAM сервера |
| **Учёт не-контейнерных агентов** | Полная прозрачность состава | Явно помечаются статусом `SKIPPED` | Пропуск или потеря агента в отчёте |

---

## 3. Регламент выполнения

### Шаг 1: Подготовка
- [ ] Убедиться в доступности реестра флота (`fleet-manifest.json` или через API `/api/companies/:company_id/agents`).
- [ ] Проверить список горячих ботов флота с повышенным лимитом:
  - `adm-dev-eng-10` (`887ed69b-5982-4572-a151-f8c809543f29`) → целевой лимит: **1536 MiB**
  - `adm-dev-eng-8` (`90192a57-8b26-4d3f-b65f-bd3fc7feda8b`) → целевой лимит: **1536 MiB**
  - Все остальные контейнерные боты → целевой лимит: **1024 MiB**

### Шаг 2: Запуск smoke-проверки

#### Вариант A: На хосте с Docker в живом контуре
```bash
./scripts/myrmidon/deploy/bot-memory-smoke.sh \
  --manifest reports/full-fleet-manifest.json \
  --json-out /tmp/bot-memory-smoke-report.json \
  --table-out /tmp/bot-memory-smoke-report.md
```

#### Вариант B: Офлайн-проверка по дампу inspect (в CI / контейнере инженера)
```bash
# 1. На боевом сервере с правами docker (только чтение):
docker inspect $(docker ps -a -q --filter "name=myrmidon-bot-") > bot-inspect-dump.json

# 2. Запуск проверки по дампу:
./scripts/myrmidon/deploy/bot-memory-smoke.sh \
  --input bot-inspect-dump.json \
  --manifest reports/full-fleet-manifest.json \
  --json-out bot-memory-smoke-report.json \
  --table-out bot-memory-smoke-report.md
```

---

## 4. Интерпретация результатов и действия при отклонениях

### Значения вердиктов
- `PASS [OK]`: Все контейнеры запущены, `State.OOMKilled` равен `false`, лимиты памяти совпадают с целевыми.
- `FAIL_OOMKILLED`: Контейнер был принудительно завершён ядром Linux из-за превышения cgroup-лимита (`exit code 137`).
- `FAIL_MEMORY_MISMATCH`: Контейнер имеет старый лимит памяти (например, 4096 MiB или неограниченный `0`).
- `FAIL_MISSING`: Контейнер ожидаемого бота отсутствует на хосте.
- `SKIPPED`: Локальный агент вне Docker (`antigravity_local`, `claude_local`, `openclaw_gateway`), корректно учтён и пропущен.

### Действия при ошибках

#### При обнаружении `FAIL_OOMKILLED`:
1. Найти имя бота и ID в таблице отчёта.
2. Снять статистику использования памяти:
   ```bash
   docker logs --tail 200 myrmidon-bot-<agentId>
   ```
3. Согласовать с лидом/архитектором включение бота в список "горячих" с лимитом 1536 MiB.

#### При обнаружении `FAIL_MEMORY_MISMATCH`:
1. Проверить значение в карточке агента на доске:
   ```bash
   curl -s -H "Authorization: Bearer $API_KEY" http://127.0.0.1:3100/api/agents/<agentId> | jq '.adapterConfig.container.memoryMb'
   ```
2. Если в карточке лимит верный, но контейнер ещё не пересоздан, выполнить реконсиляцию через оператора во время регламентного окна.

---

## 5. Форма протокола приёмки

```text
Дата проверки:          [ГГГГ-ММ-ДД ЧЧ:ММ UTC]
Проверяющий оператор:   [adm / имя оператора]
Релиз / контекст:       1.6.6 T4 Выравнивание лимитов памяти флота
Всего агентов оценено:  [66]
Контейнерных ботов:     [63]
Не-контейнерных (пропуск): [3] (adm-dev-eng-17, bbq-editor-retired, adm2-cli)
Статус State.OOMKilled: 0 обнаружено (PASSED)
HostConfig.Memory:      63/63 совпали (61 @ 1024 MiB, 2 @ 1536 MiB)
Суммарная память флота: 65 536 MiB (64.00 GiB) / Host RAM 68.00 GiB
Итоговый вердикт:       PASSED [OK]
Файл отчёта:            ope-8425-bot-memory-smoke-sample-report.md
```
