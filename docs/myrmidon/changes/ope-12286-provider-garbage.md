---
settings-section: Track 5 — operations
---

## changelog-en

### Provider garbage detection and bounded retry protection (OPE-12286)
Upstream model provider stub replies (e.g. maintenance notices or overloaded messages returned with HTTP 200 in sub-second time) are now detected and classified as `provider_garbage`. The heartbeat persists a `run.provider_garbage.detected` event, and the devflow health collector turns recent events into one critical (P1) signal per outcome/model-group burst, including the outcome text and model group. Suspect runs do not enter recovery-block; instead, they receive bounded retries with a pause (`MYRMIDON_PROVIDER_GARBAGE_RETRY_MAX_ATTEMPTS`, default 3; delay `MYRMIDON_PROVIDER_GARBAGE_RETRY_DELAY_MS`, default 300s).

## changelog-ru

### Детектор мусорных ответов провайдера и защита от зацикливания (OPE-12286)
Ответы-заглушки провайдеров моделей (например, сообщения об обслуживании или перегрузке, возвращаемые с кодом HTTP 200 менее чем за секунду) теперь детектируются и классифицируются как `provider_garbage`. Heartbeat сохраняет событие `run.provider_garbage.detected`, а коллектор здоровья devflow превращает свежие события в один критический (P1) сигнал на всплеск по тексту ответа и группе моделей, включая эти данные в карточку. Подозрительные прогоны не уходят в recovery-блок; вместо этого для них выполняются ограниченные повторы с паузой (`MYRMIDON_PROVIDER_GARBAGE_RETRY_MAX_ATTEMPTS`, по умолчанию 3; задержка `MYRMIDON_PROVIDER_GARBAGE_RETRY_DELAY_MS`, по умолчанию 300с).

## settings-en

| `MYRMIDON_PROVIDER_GARBAGE_DISTINCT_AGENTS` | OPE-12286 | `5` | Minimum number of distinct agents producing the same short outcome within the window to trigger a provider garbage hit | `1` — any repetition |
| `MYRMIDON_PROVIDER_GARBAGE_SAME_AGENT_RUNS` | OPE-12286 | `5` | Minimum number of runs on the same agent producing the same short outcome within the window | `1` — single run |
| `MYRMIDON_PROVIDER_GARBAGE_WINDOW_MS` | OPE-12286 | `600000` (10m) | Sliding window duration in milliseconds for counting repeated short outcomes across agents | Window duration in ms |
| `MYRMIDON_PROVIDER_GARBAGE_MAX_OUTCOME_CHARS` | OPE-12286 | `200` | Maximum length in code points for an outcome text to be eligible for stub/garbage classification | Max character count |
| `MYRMIDON_PROVIDER_GARBAGE_RETRY_MAX_ATTEMPTS` | OPE-12286 | `3` | Maximum number of bounded retries for a run marked as provider garbage | `0` — do not retry provider garbage |
| `MYRMIDON_PROVIDER_GARBAGE_RETRY_DELAY_MS` | OPE-12286 | `300000` (5m) | Pause duration in milliseconds before retrying a run marked as provider garbage | Delay in ms |
| `MYRMIDON_PROVIDER_GARBAGE_SIGNATURES` | OPE-12286 | `tạm thời bảo trì..., server overloaded` | Comma-separated list of known stub signatures matching short outcomes case-insensitively | Additional signatures |

## settings-ru

| `MYRMIDON_PROVIDER_GARBAGE_DISTINCT_AGENTS` | OPE-12286 | `5` | Минимальное число разных агентов с одинаковым коротким итогом за окно для срабатывания детектора мусора | `1` — любое повторение |
| `MYRMIDON_PROVIDER_GARBAGE_SAME_AGENT_RUNS` | OPE-12286 | `5` | Минимальное число прогонов у одного агента с одинаковым коротким итогом за окно | `1` — один прогон |
| `MYRMIDON_PROVIDER_GARBAGE_WINDOW_MS` | OPE-12286 | `600000` (10м) | Длительность скользящего окна в миллисекундах для подсчета повторяющихся коротких итогов | Длительность окна в мс |
| `MYRMIDON_PROVIDER_GARBAGE_MAX_OUTCOME_CHARS` | OPE-12286 | `200` | Максимальная длина в символах для итога, при которой он может классифицироваться как заглушка/мусор | Макс. число символов |
| `MYRMIDON_PROVIDER_GARBAGE_RETRY_MAX_ATTEMPTS` | OPE-12286 | `3` | Максимальное число ограниченных повторов для прогона, отмеченного как мусор от провайдера | `0` — не повторять прогон мусора |
| `MYRMIDON_PROVIDER_GARBAGE_RETRY_DELAY_MS` | OPE-12286 | `300000` (5м) | Длительность паузы в миллисекундах перед повтором прогона с мусором провайдера | Задержка в мс |
| `MYRMIDON_PROVIDER_GARBAGE_SIGNATURES` | OPE-12286 | `tạm thời bảo trì..., server overloaded` | Список известных сигнатур заглушек через запятую для регистронезависимого сопоставления | Дополнительные сигнатуры |
