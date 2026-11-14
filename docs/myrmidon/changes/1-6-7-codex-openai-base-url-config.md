## changelog-en

### Native runner: the gateway address now reaches Codex through its config file

Codex 0.157 ignores the `OPENAI_BASE_URL` environment variable and reads the gateway address only
from the `openai_base_url` key of its config. Passing the variable (previous fix) was therefore not
enough: a native Codex agent that used an LLM gateway (for example LiteLLM) still sent its gateway
key to api.openai.com and got 401 on the first turn. When the agent environment has
`OPENAI_BASE_URL`, the native runner now also writes `openai_base_url = "<url>"` to the
`config.toml` of the isolated Codex home, ahead of all tables and next to the existing keys. Only an
`http://` or `https://` address without whitespace, quotes or control characters is accepted; any
other value stops the launch with a clear error that does not repeat the value. Without
`OPENAI_BASE_URL` the config is unchanged.

## changelog-ru

### Нативный раннер: адрес шлюза теперь доходит до Codex через его конфиг

Codex 0.157 игнорирует переменную окружения `OPENAI_BASE_URL` и берёт адрес шлюза только из ключа
`openai_base_url` своего конфига. Одной передачи переменной (прошлое исправление) оказалось мало:
нативный агент Codex, работающий через шлюз моделей (например LiteLLM), по-прежнему отправлял ключ
шлюза на api.openai.com и получал 401 на первом ходу. Теперь, если в окружении агента есть
`OPENAI_BASE_URL`, нативный раннер дополнительно пишет `openai_base_url = "<url>"` в `config.toml`
изолированного домашнего каталога Codex — перед всеми таблицами и рядом с уже существующими
ключами. Принимается только адрес `http://` или `https://` без пробелов, кавычек и управляющих
символов; любое другое значение останавливает запуск понятной ошибкой, в которой само значение не
повторяется. Без `OPENAI_BASE_URL` конфиг не меняется.
