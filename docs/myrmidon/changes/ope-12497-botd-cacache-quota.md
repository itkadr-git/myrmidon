---
divergence-section: Трек 5 — эксплуатация
settings-section: Track 5 — operations
---

## changelog-en

### Per-bot npm content cache quota (1.6.7 BOT-DISK)

- botd now enforces a 512 MiB per-bot `hermes/.npm/_cacache` limit after age-based cache cleanup. It removes oldest complete content and index shards first, skips open paths and active runs, and logs each idle quota pass.

## changelog-ru

### Квота npm-кэша каждого бота (1.6.7 BOT-DISK)

- botd после очистки по возрасту ограничивает `hermes/.npm/_cacache` каждого бота 512 МиБ. Удаляет сначала старые целые фрагменты content/index, не трогает открытые пути и активный прогон, журналирует каждый проход квоты в простое.

## divergence

| 1.6.7-BOT-DISK-CACACHE | botd: возрастной проход и затем квота `hermes/.npm/_cacache` 512 МиБ на бота; журнал проходов | `docker/bot-runtime/botd/{botd,lib/hygiene.js}` | Неконтролируемый рост npm-кэша заполнял раздел ботов | `scripts/myrmidon/bot-runtime/botd-hygiene.test.mjs` | Удалить отдельную квоту и оставить прежний общий cap `.npm` | OPE-12497 |

## settings-en

| `MYRMIDON_BOTD_NPM_CACACHE_QUOTA_BYTES` | 1.6.7-BOT-DISK-CACACHE | `536870912` (512 MiB) | Per-bot size ceiling for `hermes/.npm/_cacache`, applied by botd after TTL cleanup on idle and pressure passes. Oldest complete content/index shards are evicted until within quota; active runs and open paths are skipped. Each idle pass is logged | Unset, zero or invalid — default 512 MiB |

## settings-ru

| `MYRMIDON_BOTD_NPM_CACACHE_QUOTA_BYTES` | 1.6.7-BOT-DISK-CACACHE | `536870912` (512 МиБ) | Предел размера `hermes/.npm/_cacache` одного бота: после очистки по возрасту botd в обычном и аварийном проходе удаляет старейшие целые фрагменты content/index до квоты. Активный прогон и открытые пути пропускаются, проход журналируется | Не задана, ноль или неверное значение — 512 МиБ |
