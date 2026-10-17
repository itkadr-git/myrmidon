---
settings-section: 1.6.6 — CORPUS-2.0 C: knowledge corpus server side
---

## settings-en

| `MYRMIDON_CORPUS_EMBEDDER_API_KEY` | CORPUS-2.0 integration | unset | Optional credential override for the configured embedding gateway; prefer the company's standard secret mechanism and never place this value in settings or logs | Unset — use the company's standard credential resolver; configure a secret only through the approved secret store |
| `MYRMIDON_LLM_GATEWAY_BASE_URL` | CORPUS-2.0 integration | unset | Base URL of the company LLM gateway used when no corpus-specific embedder URL is configured | Unset — the embedder's standard configured URL applies |

## settings-ru

| `MYRMIDON_CORPUS_EMBEDDER_API_KEY` | CORPUS-2.0 integration | не задан | Необязательное переопределение учётных данных шлюза эмбеддингов; предпочитайте штатный механизм секретов компании и никогда не помещайте значение в настройки или логи | Не задан — используется штатный resolver секретов компании; секрет задаётся только через разрешённое хранилище секретов |
| `MYRMIDON_LLM_GATEWAY_BASE_URL` | CORPUS-2.0 integration | не задан | Base URL шлюза LLM компании, когда URL эмбеддера для корпуса явно не задан | Не задан — используется стандартный настроенный URL эмбеддера |