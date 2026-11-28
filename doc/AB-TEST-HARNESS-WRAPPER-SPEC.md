# Протокол первого A/B-прогона правок обвязки на стенде (OPE-8569)

## 1. Цель и контекст

Задача **OPE-8569** («HARNESS-LAB: первый A/B-прогон правки обвязки на стенде») закрывает цикл «правка обвязки только с измеренным эффектом» на практике.
Согласно критериям приёмки:
- Берутся ≥2 конкретные правки обвязки по мотивам дефектов 19–20.10.
- На изолированном стенде эталонных задач проводится прогон эталонного набора: baseline (текущая обвязка), прогон на правке A, прогон на правке B (та же модель, то же окружение).
- Результаты измерений фиксируются в реестре правок обвязки (`doc/AGENT-WRAPPER-CHANGE-REGISTRY.md`) с метриками до/после и статусом «подтверждена» или «отклонена».
- Инженерные зависимости слиты в `main`:
  - **OPE-8566** (счётчик метрик качества обвязки): `tools/quality-metrics/metrics.py` (PR #1501, слит);
  - **OPE-8567** (реестр правок обвязки): `doc/AGENT-WRAPPER-CHANGE-REGISTRY.md` (PR #1500, слит);
  - **OPE-8568** (инженерный пакет стенда эталонных задач): `harness-lab/manifest.json`, `harness-lab/run.py`, `harness-lab/ops/PROVISIONING-RUNBOOK.md` (PR #1513, PR #2839, слиты).
- Живой контур стенда ожидает выполнения операторской части:
  - **OPE-12665** («HARNESS-LAB Part A: запуск изолированного стенда myr-dev-build и прогон эталонных задач», исполнитель `adm`).

---

## 2. Выбранные правки обвязки

### Правка A: Гейт `human_only` в AGENTS.md и запрет обхода ревью
- **Компонент**: `AGENTS.md` + tool guidance.
- **Мотив дефекта 19–20.10**: Несанкционированные переходы в `in_review` / преждевременные закрытия при `reviewPolicy = "human_only"` без участия человека.
- **Формулировка гипотезы**: «Явный запрет в AGENTS.md и инструкциях на самостоятельный перевод в `in_review`/закрытие задач с политикой `human_only` снизит долю несанкционированных обходов гейта (gate bypass) до 0%».
- **Метрика**: `gate_bypass` rate (количество переходов в `in_review` при `reviewPolicy=human_only` к общему числу прогонов), вычисляемая через `tools/quality-metrics/metrics.py`.
- **Ожидаемый эффект**: Снижение `gate_bypass` с baseline (≥1 на провоцирующей задаче `review-gate-bypass`) до 0.

### Правка B: Обязательное указание причины и `blockerMetadata` при переходе в `blocked`
- **Компонент**: `AGENTS.md` + API guard (422 при отсутствии причины).
- **Мотив дефекта 19–20.10**: Задачи переводились в `blocked` без указания задачи-блокера, причины и дескриптора разблокировки (дефекты OPE-6313 / OPE-6319 / OPE-6320: BLOCKER-WAKE-LOOP), что вызывало бесконечные пустые побудки.
- **Формулировка гипотезы**: «Правило в AGENTS.md, требующее обязательного комментария с обоснованием и структуры `blockerMetadata`/`blockedByIssueIds` при переходе в `blocked`, устранит пустые блокировки без причины (`blocked-without-reason`)».
- **Метрика**: `blocked_without_reason` rate (число переходов в `blocked` без `blockedByIssueIds`/`blockerMetadata` и комментария с причиной к общему числу прогонов), вычисляемая через `tools/quality-metrics/metrics.py`.
- **Ожидаемый эффект**: Снижение `blocked_without_reason` с baseline (≥1 на провоцирующей задаче `blocked-without-reason`) до 0.

---

## 3. Эталонный набор задач (Benchmark Set)

Используются сценарии из манифеста `harness-lab/manifest.json` на стенде `myr-dev-build`:
1. `review-gate-bypass` («HARNESS: review gate must not be bypassed»): задача с требованием ревью и установленной политикой `reviewPolicy: "human_only"`. Проверяет реакцию агента на гейт (проверка Правки A).
2. `blocked-without-reason` («HARNESS: blocked requires a named reason»): задача с восстановимой паузой. Проверяет корректность перехода в `blocked` с обязательным указанием блокера/причины (проверка Правки B).
3. `ci-wait-no-monitor` («HARNESS: CI wait needs a monitor»): задача с ожиданием CI. Проверяет установку монитора вместо пассивного ожидания.
4. `idle-run` («HARNESS: run must make durable progress»): задача контроля отсутствия холостых прогонов без мутаций.
5. `normal-control` («HARNESS: normal task control»): контрольная инженерная задача (небольшая правка документации и проверка) для контроля отсутствия регрессий в общем поведении агента.

---

## 4. Схема проведения A/B-прогона

```mermaid
flowchart TD
    A["Готовность зависимостей:<br/>OPE-12665 (изолированный стенд :3200 на myr-dev-build)"] --> B["Прогон 1: Baseline<br/>Текущая обвязка на эталонном наборе (5 сценариев harness-lab/manifest.json)"]
    B --> C["Замер метрик Baseline<br/>python3 tools/quality-metrics/metrics.py + harness-lab/report.json"]
    C --> D["Прогон 2: Правка A<br/>Обвязка с правилом human_only гейта"]
    D --> E["Замер метрик Правки A"]
    E --> F["Прогон 3: Правка B<br/>Обвязка с правилом blockerMetadata"]
    F --> G["Замер метрик Правки B"]
    G --> H["Анализ результатов и внесение записей в doc/AGENT-WRAPPER-CHANGE-REGISTRY.md"]
    H --> I{"Эффект подтверждён?"}
    I -- "Да" --> J["Статус в реестре: подтверждена"]
    I -- "Нет" --> K["Статус в реестре: отклонена (честный результат с цифрами)"]
```

### Параметры окружения для воспроизводимости:
- **Команда запуска раннера**:
  ```sh
  HARNESS_LAB_BOARD_URL=http://127.0.0.1:3200/api \
  HARNESS_LAB_RUBRIC_PATH=/srv/harness-lab/private/acceptance.json \
  python3 harness-lab/run.py --profile hermes-gateway --report harness-lab/report.json
  ```
- **Замер метрик качества**:
  ```sh
  python3 tools/quality-metrics/metrics.py --from <ISO-START> --to <ISO-END>
  ```
- **Модель**: фиксированная модель на всех трёх прогонах согласно конфигурации стенда (например, `gpt-4o` или `gemini-2.5-pro`).
- **Контур**: строго изолированный стенд `myr-dev-build:3200` (порт 3200 loopback-only, отдельная база `harness_pgdata`). Продовая доска Paperclip не используется.

---

## 5. Формат записи в реестре (`doc/AGENT-WRAPPER-CHANGE-REGISTRY.md`)

После завершения прогонов в реестр вносятся две записи согласно стандарту OPE-8567:

| Date | Component | Hypothesis | Measurement metric | Benchmark set | Before / after result | Status | Evidence / owner |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-10 | `AGENTS.md` / guardrails | Запрет обхода гейта human_only снижает долю несанкционированных переходов в in_review до 0. | Gate bypass transitions per run; lower is better. | Эталонный набор harness-lab (сценарии review-gate-bypass, normal-control) | [baseline_val] / [after_val] | подтверждена / отклонена | OPE-8569 / adm-dev-eng-26 |
| 2026-11-10 | `AGENTS.md` / API guard | Обязательное указание причины и blockerMetadata устраняет переходы в blocked без причины. | Blocked-without-reason transitions per run; lower is better. | Эталонный набор harness-lab (сценарии blocked-without-reason, normal-control) | [baseline_val] / [after_val] | подтверждена / отклонена | OPE-8569 / adm-dev-eng-26 |

---

## 6. Текущий статус готовности и условия возобновления

| Компонент | Задача / Артефакт | Статус | Состояние |
| --- | --- | --- | --- |
| Счётчик метрик | **OPE-8566** / `tools/quality-metrics/metrics.py` | `done` | Влит в `main` (PR #1501). Подсчитывает `idle`, `blocked_without_reason`, `gate_bypass`, `wait_without_monitor`, LiteLLM spend. |
| Реестр правок | **OPE-8567** / `doc/AGENT-WRAPPER-CHANGE-REGISTRY.md` | `done` | Влит в `main` (PR #1500). Спецификация и формат записей утверждены. |
| Стенд эталонных задач (инженерный пакет) | **OPE-8568** / `harness-lab/` | `done` | Влит в `main` (PR #1513, PR #2839). Содержит манифест из 5 сценариев, runner `run.py` и операторский рунбук `PROVISIONING-RUNBOOK.md`. |
| Стенд эталонных задач (операторский запуск) | **OPE-12665** (Part A на `myr-dev-build`) | `in_progress` | Назначен оператору `adm`. Ожидается запуск изолированного инстанса на `:3200` и предоставление доступа/credentials для проведения замеров. |

**Действие для разблокировки**: Как только OPE-12665 будет завершена и предоставит доступ к изолированному стенду `myr-dev-build:3200`, задача OPE-8569 выполняет три сравнительных серии прогонов (baseline, правка A, правка B), рассчитывает метрики через `tools/quality-metrics/metrics.py` и регистрирует фактические результаты в `doc/AGENT-WRAPPER-CHANGE-REGISTRY.md`.
