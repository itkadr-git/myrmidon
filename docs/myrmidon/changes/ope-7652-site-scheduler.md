---
settings-section: Track 5 — operations
---

## settings-en

| `MYRMIDON_SITE_SCHEDULER` | REMOTE-SITES-T5 | unset (off) | Turns on the `site-scheduler` lane (30 s): moves a bot whose affinity site differs from its current one through the move state machine; a bot whose affinity site is full is marked `pending_placement` on its card and logged, never placed locally. Read at server startup; needs `MYRMIDON_BOT_CONTAINERS` | Unset or any value but `1` — the lane is not started |
| `MYRMIDON_SITE_SCHEDULER_PREEMPTION` | REMOTE-SITES-T5 | unset (off) | Lets the scheduler displace a low-priority bot from a full site for a critical (P0) one | Unset or any value but `1` — no preemption. Applies only while `MYRMIDON_SITE_SCHEDULER` is on |
| `MYRMIDON_LOCAL_SITE_AGENT_URL` | REMOTE-SITES-T5 | unset | Address of the site-agent on the board host itself, needed to move a bot to or from the board host | Unset — a move that touches the board host fails with a configuration error before anything is stopped |
| `MYRMIDON_LOCAL_SITE_AGENT_TOKEN_SECRET` | REMOTE-SITES-T5 | unset | Name of the company secret that holds the token of the board host's site-agent | Unset — same as above; the token itself is never in the setting or the log |

## settings-ru

| `MYRMIDON_SITE_SCHEDULER` | REMOTE-SITES-T5 | не задан (выключено) | Включает lane `site-scheduler` (30 с): переносит бота, чья affinity-площадка отличается от текущей, автоматом переноса; бот, чья affinity-площадка заполнена, помечается в карточке `pending_placement` и попадает в журнал, на локальную площадку не уходит. Читается при запуске сервера; нужен `MYRMIDON_BOT_CONTAINERS` | Не задан или не `1` — lane не запускается |
| `MYRMIDON_SITE_SCHEDULER_PREEMPTION` | REMOTE-SITES-T5 | не задан (выключено) | Разрешает планировщику вытеснить бота низкого приоритета с заполненной площадки ради критичного (P0) | Не задан или не `1` — вытеснения нет. Действует, только пока включён `MYRMIDON_SITE_SCHEDULER` |
| `MYRMIDON_LOCAL_SITE_AGENT_URL` | REMOTE-SITES-T5 | не задан | Адрес site-agent на самом хосте доски: нужен для переноса бота на хост доски и с него | Не задан — перенос, затрагивающий хост доски, падает с ошибкой настройки до остановки бота |
| `MYRMIDON_LOCAL_SITE_AGENT_TOKEN_SECRET` | REMOTE-SITES-T5 | не задан | Имя секрета компании с токеном site-agent хоста доски | Не задан — как выше; сам токен в настройке и журнале не хранится |

## changelog-en

### REMOTE-SITES-T5: site scheduler and bot move between sites (OPE-7652)

- New `site-scheduler` lane (30 s), off by default (`MYRMIDON_SITE_SCHEDULER=1` with `MYRMIDON_BOT_CONTAINERS` on). It reads the site registry and the affinity rules and moves a bot whose affinity site differs from the one it runs on, one move at a time, with the move state machine below (never by rewriting `container.host` alone). A bot whose affinity site is full stays where it is, is marked `placementStatus: pending_placement` on its card and logged as a warning, never silently placed locally. Capacity-only verdicts and pinned bots cause no action. Preemption (low priority by a critical bot) needs `MYRMIDON_SITE_SCHEDULER_PREEMPTION=1`.
- New `POST /fleet/bots/:key/move` (and `GET` for the latest move) runs a persisted state machine (stop, snapshot, restore, host, reconcile, apiBaseUrl, quarantine) with a phase log. The bot key is the agent id; the caller needs access to the bot's company. The agent's maintenance window is held for the whole move, the per-bot lock keeps the reconcile sweep out, and a failure rolls the bot back to the source site. The source datadir is only set aside at the end (`.quarantined-*`), never deleted.
- fleetd gains `snapshot`, `restore` and `quarantine` handlers. The archive is a tar inside a zstd frame (raw blocks: not compressed yet) ending with a manifest (entries, bytes, SHA-256) that restore verifies; a snapshot that breaks off aborts the response and restore refuses an archive without a matching manifest. Restore unpacks beside the datadir and swaps it in, keeping the replaced one as `.replaced-<bot>-<time>`; hard links are archived as separate files.
- A move needs the site's token as a company secret (`MYRMIDON_FLEET_HOSTS` entry `tokenSecret`, or `token_secret` in `myrmidon_fleet_sites`). Moving to or from the board host needs its site-agent: `MYRMIDON_LOCAL_SITE_AGENT_URL` and `MYRMIDON_LOCAL_SITE_AGENT_TOKEN_SECRET`. Sites and affinity rules are rows in `myrmidon_fleet_sites` and `myrmidon_fleet_affinity` (no admin routes yet). The migration adds `myrmidon_fleet_sites`, `myrmidon_fleet_affinity` and `myrmidon_fleet_moves`.

## changelog-ru

### REMOTE-SITES-T5: планировщик площадок и перенос бота (OPE-7652)

- Новый lane `site-scheduler` (30 с), по умолчанию выключен (`MYRMIDON_SITE_SCHEDULER=1` при включённом `MYRMIDON_BOT_CONTAINERS`). Читает реестр площадок и правила affinity и переносит бота, чья affinity-площадка отличается от текущей, по одному за раз, автоматом переноса ниже (не простой правкой `container.host`). Бот, чья affinity-площадка заполнена, остаётся на месте, помечается в карточке `placementStatus: pending_placement` и попадает в журнал как предупреждение, молча на локальную площадку он не уходит. Решения только по ёмкости и привязанные боты ничего не вызывают. Вытеснение (low критичным ботом) включается `MYRMIDON_SITE_SCHEDULER_PREEMPTION=1`.
- Новый `POST /fleet/bots/:key/move` (и `GET` последнего переноса) ведёт сохраняемый автомат (stop, snapshot, restore, host, reconcile, apiBaseUrl, quarantine) с журналом фаз. Ключ бота — id агента; нужен доступ к компании бота. Окно обслуживания агента держится весь перенос, замок бота не пускает цикл сверки, при сбое бот возвращается на исходную площадку. Исходный датадир откладывается только в конце (`.quarantined-*`) и не удаляется.
- fleetd получает обработчики `snapshot`, `restore`, `quarantine`. Архив — tar внутри кадра zstd (сырые блоки: пока без сжатия), в конце манифест (записи, байты, SHA-256), который проверяет restore; оборванный снимок обрывает ответ, restore не принимает архив без совпавшего манифеста. Restore распаковывает рядом и подменяет датадир целиком, прежний остаётся как `.replaced-<бот>-<время>`; жёсткие ссылки архивируются отдельными файлами.
- Для переноса нужен токен площадки как секрет компании (`tokenSecret` в `MYRMIDON_FLEET_HOSTS` или `token_secret` в `myrmidon_fleet_sites`). Перенос на хост доски и с него требует его site-agent: `MYRMIDON_LOCAL_SITE_AGENT_URL` и `MYRMIDON_LOCAL_SITE_AGENT_TOKEN_SECRET`. Площадки и правила affinity — строки `myrmidon_fleet_sites` и `myrmidon_fleet_affinity` (админ-ручек пока нет). Миграция добавляет таблицы `myrmidon_fleet_sites`, `myrmidon_fleet_affinity`, `myrmidon_fleet_moves`.
