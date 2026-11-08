---
settings-section: Track 6 — security and models
---
## settings-en
| `MYRMIDON_LLM_API_KEY` | M2-B | — (an env name on the agent card, not a server setting) | Default name of the agent card's env binding that carries the agent's own LiteLLM key (`adapter_config.env.MYRMIDON_LLM_API_KEY`, a `secret_ref` to a company secret). The board's LiteLLM sync reads this binding to find which gateway key belongs to the agent when it updates the key's model allowlist; the board never reads the value into its own environment. `MYRMIDON_LITELLM_AGENT_KEY_ENV` names a different env name | — |

## settings-ru
| `MYRMIDON_LLM_API_KEY` | M2-B | — (имя переменной в карточке агента, не настройка сервера) | Имя по умолчанию для привязки env в карточке агента, через которую бот получает свой ключ LiteLLM (`adapter_config.env.MYRMIDON_LLM_API_KEY`, `secret_ref` на секрет компании). Синхронизация LiteLLM доски читает эту привязку, чтобы найти ключ агента при обновлении списка разрешённых ему моделей; в своё окружение доска значение не берёт. Другое имя задаёт `MYRMIDON_LITELLM_AGENT_KEY_ENV` | — |
