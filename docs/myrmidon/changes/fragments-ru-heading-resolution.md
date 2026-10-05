## changelog-en

### Fragments with a settings-ru section fold into the RU settings document again

- `collect-fragments.mjs` resolves the `settings-section` heading inside
  SETTINGS.ru.md by a language-independent key (release version + the all-caps
  feature-id tokens of the heading) when the exact EN heading is absent, so a
  fragment that names the EN section — as every fragment does — folds its
  `settings-ru` rows into the Russian variant of that section instead of
  failing the release cut (the RU file never carried the EN headings, contrary
  to what the fragment README claimed; `bot-disk-quota.md` hit exactly this).
  An exact heading still wins; an ambiguous key match is not guessed and fails
  loudly as before.
- `change-fragments-gate-selftest.test.mjs` now also runs
  `collect-fragments --version 0.0.0 --dry-run` over the checked-out tree: a
  fragment the collector cannot fold turns the PR red before merge instead of
  breaking the next release cut. No workflow file was touched — the check
  rides the existing `node --test` step of the `checks` job.

## changelog-ru

### Фрагменты с settings-ru снова складываются в RU-документ настроек

- `collect-fragments.mjs` разрешает заголовок `settings-section` внутри
  SETTINGS.ru.md по языково-независимому ключу (версия релиза + all-caps
  токены фичи из заголовка), когда точный EN-заголовок отсутствует: фрагмент,
  называющий EN-раздел — как делают все фрагменты, — складывает свои строки
  `settings-ru` в русскую версию этого раздела, а не валит нарезку релиза
  (RU-файл никогда не нёс EN-заголовки вопреки описанию в README фрагментов;
  на этом споткнулся `bot-disk-quota.md`). Точный заголовок по-прежнему
  приоритетнее; неоднозначное совпадение ключа не угадывается и падает так же
  громогласно, как раньше.
- `change-fragments-gate-selftest.test.mjs` теперь также гоняет
  `collect-fragments --version 0.0.0 --dry-run` по проверенному дереву:
  фрагмент, который сборщик не может сложить, красит PR до слияния, а не
  ломает следующий нарез релиза. Файлы workflow не тронуты — проверка едет на
  существующем шаге `node --test` job `checks`.
