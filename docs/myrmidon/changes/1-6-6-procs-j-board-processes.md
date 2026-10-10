---
divergence-section: Трек 2 — ядро побудок и прогонов
settings-section: Track 5 — operations
---

## changelog-en

### The board's process composition is a setting: `general.processes` (PROCS-J)

- The composition of the board — how many HTTP processes (`api`) and how many scheduler
  processes (`worker`) a deployment runs — is now read at startup from the instance
  settings key `general.processes`. An absent key (the usual case) means
  `{ api: 1, worker: 0 }` — today's single process — so a deployment that does not set it
  starts exactly as before.
- A composition that cannot be read refuses startup instead of being guessed: counts that
  are not whole numbers `>= 0`, or a row that asks for no process at all
  (`api + worker < 1`), stop the board with the key, the values and the fix in the log.
- PROCS-1.1 (the mode and the per-role gates of the same feature) stores its own fields in
  the same row; the counts are read on their own, so neither part of the feature refuses
  the other's row.

## changelog-ru

### Состав процессов доски — настройка `general.processes` (PROCS-J)

- Состав доски — сколько HTTP-процессов (`api`) и сколько планировщиков (`worker`)
  запускает развёртывание — теперь читается при старте из ключа настроек экземпляра
  `general.processes`. Ключа нет (обычный случай) — это `{ api: 1, worker: 0 }`,
  сегодняшний одиночный процесс: развёртывание без ключа стартует ровно как раньше.
- Нечитаемый состав отказывает старту вместо догадки: значения не целые или `< 0`, либо
  строка просит ни одного процесса (`api + worker < 1`) — доска останавливается, а в
  журнале есть ключ, значения и что исправить.
- PROCS-1.1 (режим и роли той же части) хранит свои поля в той же строке; счётчики
  читаются отдельно, поэтому ни одна часть не отвергает строку другой.

## divergence

| PROCS-J | Состав процессов доски (`api` HTTP-процессов, `worker` планировщиков) читается при старте из `instance_settings.general.processes` и валидируется там же: счётчики — целые `>= 0`, сумма `>= 1`, дефолт `{ api: 1, worker: 0 }` (одиночный процесс, как раньше); нечитаемая строка отказывает старту с понятной ошибкой | `server/src/index.ts`, `server/src/services/instance-settings.ts`, `packages/shared/src/validators/instance.ts`, `packages/shared/src/types/instance.ts` | У вендора доска однопроцессная: ключа состава процессов нет, а развёртывание многопроцессного режима (проект OPE-5394) требует его до старта приложения. Тот же ключ позже наполняет PROCS-1.1 (режим и роли) | `server/src/myrmidon/board-processes/settings.myrmidon.test.ts`, `packages/shared/src/myrmidon-board-processes.test.ts` | Когда вендор заведёт собственный ключ состава процессов (или PROCS-1.1 вольёт свою схему того же ключа): снять чтение и валидацию частей `myrmidon(1.6.6 PROCS-J)`, тесты оставить на поведение вендора | (этот PR) |

## settings-en

| `general.processes` (settings area) | PROCS-J | `{ api: 1, worker: 0 }` | The board's process composition: how many HTTP processes (`api`) and scheduler processes (`worker`) this deployment runs, read once at startup. An absent key is today's single process; a stored count that is not a whole number `>= 0`, or `api + worker < 1`, refuses startup with the fix in the log. PROCS-1.1 stores the mode and the role gates in the same row | No key — single process (the default). Fix or remove the row to start again |

## settings-ru

| `general.processes` (область настроек) | PROCS-J | `{ api: 1, worker: 0 }` | Состав процессов доски: сколько HTTP-процессов (`api`) и планировщиков (`worker`) запускает развёртывание, читается один раз при старте. Ключа нет — сегодняшний одиночный процесс; нечитаемый счётчик (не целое или `< 0`) либо `api + worker < 1` отказывает старту и называет исправление. Режим и роли PROCS-1.1 лежат в той же строке | Ключа нет — одиночный процесс (умолчание). Исправить или удалить строку, чтобы стартовать снова |