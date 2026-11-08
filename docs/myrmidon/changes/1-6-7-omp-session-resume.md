## changelog-en

### OMP agents resume their session again with omp 18.9.2

omp 18.9.2 writes a `{"type":"title",…}` line before the `{"type":"session",…,"cwd":…}`
header of a session file. The omp-local adapter read only the first line, never found the
saved working directory and started every next heartbeat as a fresh session (OPE-12287).
The header is now looked up among the first 10 lines (the remote path reads `head -n 10`
too), so both the old and the new session file formats resume with `--session <file>`.

## changelog-ru

### Агенты OMP снова продолжают свою сессию на omp 18.9.2

omp 18.9.2 пишет строку `{"type":"title",…}` перед заголовком `{"type":"session",…,"cwd":…}`
в файле сессии. Адаптер omp-local читал только первую строку, не находил сохранённый рабочий
каталог и начинал каждое следующее пробуждение новой сессией (OPE-12287). Теперь заголовок
ищется в первых 10 строках (удалённый путь читает `head -n 10`), и оба формата файла сессии
продолжаются через `--session <file>`.
