---

---

## changelog-en

### The CLI is now called `myrmidon`; `paperclipai` keeps working (DEBRAND-d)

- The CLI package and binary are renamed to `myrmidon`. The old `paperclipai`
  binary stays as a synonym and prints `paperclipai is deprecated, use myrmidon`
  to stderr once per run, then works as before.
- Help texts of the top-level commands say Myrmidon. `PAPERCLIP_*` variables and
  `@paperclipai/*` imports are unchanged.
- Managed installs find the CLI in either package directory, so existing
  installs and updates keep working.

## changelog-ru

### CLI теперь называется `myrmidon`; `paperclipai` продолжает работать (DEBRAND-d)

- Пакет и бинарь CLI переименованы в `myrmidon`. Старый бинарь `paperclipai`
  остаётся синонимом и один раз за запуск пишет в stderr
  `paperclipai is deprecated, use myrmidon`, затем работает как раньше.
- Тексты справки верхнеуровневых команд говорят Myrmidon. Переменные
  `PAPERCLIP_*` и импорты `@paperclipai/*` не менялись.
- Управляемая установка находит CLI в любой из двух папок пакета, поэтому
  существующие установки и обновления продолжают работать.
