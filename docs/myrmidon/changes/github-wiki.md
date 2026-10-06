---
divergence-section: Трек 5 — эксплуатация
---

## changelog-en

### GitHub wiki: installation is one command, requirements with real numbers

- `docs/wiki/Installation`, `docs/wiki/Quick-start` (EN+RU) — rewritten around
  the one-line installer: `curl -fsSL https://github.com/itkadr-git/myrmidon/releases/latest/download/install.sh | sudo bash`.
  The page walks what the installer does step by step, what the user sees at
  the end, what to do when a step fails, and the options (`--version`,
  `--dir`, `--port`, `--interactive`, `--lang`, `--uninstall`).
- `docs/wiki/System-requirements` (EN+RU) — real numbers instead of "the docs
  do not name them": the installer's minimums (Ubuntu 24.04 / Debian 13,
  x86_64/aarch64, 2 CPU, 4 GB RAM, 10 GB disk, port 3100) and recommendations
  from the project's own production server (16 cores / 64 GB RAM for 74
  agents; 1–4 GB per agent, 8 GB for the board and database).
- `docs/wiki/Manual-deployment` (EN+RU, new) — the hands-on `deploy.sh`
  maintenance-window flow moved off the front pages, for experienced
  administrators.
- `docs/wiki/Upgrading-and-rollback` (EN+RU) — the installer re-run is now
  the primary update path (database dump and automatic rollback included);
  the `deploy.sh` flow remains as the operator reference.
- `docs/wiki/Home` (EN+RU) — the page list reflects the new structure.

## changelog-ru

### Вики на GitHub: установка одной командой, требования с реальными числами

- `docs/wiki/Installation`, `docs/wiki/Quick-start` (EN+RU) — переписаны
  вокруг установщика одной строкой: `curl -fsSL https://github.com/itkadr-git/myrmidon/releases/latest/download/install.sh | sudo bash`.
  Страница ведёт по шагам установщика, показывает, что увидит человек в
  конце, что делать при падении шага и какие есть параметры (`--version`,
  `--dir`, `--port`, `--interactive`, `--lang`, `--uninstall`).
- `docs/wiki/System-requirements` (EN+RU) — реальные числа вместо «документы
  не называют»: минимумы из проверок установщика (Ubuntu 24.04 / Debian 13,
  x86_64/aarch64, 2 CPU, 4 ГБ ОЗУ, 10 ГБ диска, порт 3100) и рекомендации с
  боевого сервера проекта (16 ядер / 64 ГБ ОЗУ на 74 агента; 1–4 ГБ на
  агента, 8 ГБ на доску и базу).
- `docs/wiki/Manual-deployment` (EN+RU, новая) — ручной выкат `deploy.sh` с
  окном обслуживания убран с главных страниц, для опытных администраторов.
- `docs/wiki/Upgrading-and-rollback` (EN+RU) — основной путь обновления
  теперь повторный запуск установщика (с копией базы и автоматическим
  откатом); поток `deploy.sh` остаётся справочником оператора.
- `docs/wiki/Home` (EN+RU) — список страниц приведён к новой структуре.
