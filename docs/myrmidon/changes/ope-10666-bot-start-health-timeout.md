---
settings-section: Track 3 — tool gateway and Hermes adapter
---

## settings-en

| `MYRMIDON_BOTD_SESSION_MAX_MB` | OPE-10666 | `500` | Maximum size in MB for state.db. During session retention, if database used bytes exceed this limit, oldest unpinned and inactive sessions are pruned until under limit | Unset or invalid — 500 MB (0 to disable) |

## settings-ru-append

<!-- section: Трек 3 — шлюз инструментов и адаптер Hermes -->

| `MYRMIDON_BOTD_SESSION_MAX_MB` | OPE-10666 | `500` | Максимальный размер в МБ для state.db. При очистке сессий, если используемый объём базы превышает этот лимит, старейшие неприколотые и неактивные сессии удаляются до достижения лимита | Не задана или неверна — 500 МБ (0 для отключения) |
