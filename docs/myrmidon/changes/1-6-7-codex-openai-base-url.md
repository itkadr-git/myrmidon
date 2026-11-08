## changelog-en

### Native runner: Codex can use an OpenAI-compatible gateway

The native runner passes only an allowlist of environment variables to the Codex app-server. The
list had the API key but not `OPENAI_BASE_URL`, so a Codex agent that was configured for an LLM
gateway (for example LiteLLM) still sent its requests, and its key, to api.openai.com and got
401. `OPENAI_BASE_URL` is now on both allowlists (the TypeScript transport and the Rust runnerd).
It is an address, not a credential.

## changelog-ru

### Нативный раннер: Codex может работать через OpenAI-совместимый шлюз

Нативный раннер передаёт процессу Codex только переменные окружения из белого списка. В списке
был ключ API, но не было `OPENAI_BASE_URL`, поэтому агент Codex, настроенный на шлюз моделей
(например LiteLLM), всё равно отправлял запросы вместе с ключом на api.openai.com и получал 401.
Теперь `OPENAI_BASE_URL` есть в обоих белых списках (транспорт на TypeScript и runnerd на Rust).
Это адрес, а не учётные данные.
