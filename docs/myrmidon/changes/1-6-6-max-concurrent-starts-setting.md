## settings-en-new

<!-- after: Bot containers (G-series, the 28.09 "option B" plan) -->
### OPE-10757 — bot container start semaphore (1.6.6)

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_MAX_CONCURRENT_STARTS` | OPE-10757 | `2` | How many bot containers the Docker driver starts (start plus wait for gateway health) at the same time on this host; further starts wait for a free slot | Positive integer; empty, zero, negative or non-numeric — `2` is taken. Read when the driver is created (server startup), a change requires a restart |

## settings-ru-new

<!-- after: Контейнеры ботов (G-серия, план 28.09 «вариант Б») -->
### OPE-10757 — очередь запуска контейнеров ботов (1.6.6)

| Переменная | Функция | По умолчанию | Что делает | Как выключить / особое |
|---|---|---|---|---|
| `MYRMIDON_MAX_CONCURRENT_STARTS` | OPE-10757 | `2` | Сколько контейнеров ботов драйвер Docker запускает одновременно на этом хосте (запуск и ожидание здоровья шлюза); остальные запуски ждут свободного места | Целое положительное; пусто, ноль, отрицательное или не число — берётся `2`. Читается при создании драйвера (старт сервера), смена требует перезапуска |
