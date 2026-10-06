## changelog-en

### GitHub wiki sources in the repository and automatic publishing (GITHUB-WIKI)

- The GitHub wiki of the repository is now maintained as sources in
  `docs/wiki/`: Home, Quick start, System requirements, Installation,
  Upgrading and rollback, Settings in the interface — each page in English
  and Russian (`.ru` suffix). Everything on the pages traces back to
  `docs/myrmidon/` and `scripts/myrmidon/deploy/`.
- The `myrmidon-wiki-sync` workflow publishes `docs/wiki/` to the wiki
  repository on every push to `main` that touches `docs/wiki/**` and on
  every published release, then probes every synced page over HTTP: a page
  that does not answer 200 fails the run. The job authenticates with the
  `WIKI_SYNC_TOKEN` secret — a classic PAT with the `repo` scope
  (fine-grained PATs do not cover the wiki git repository). The first wiki
  page is created by hand on GitHub: the wiki repository does not exist
  until then.

## changelog-ru

### Вики GitHub: источник в репозитории и автопубликация (GITHUB-WIKI)

- Вики репозитория на GitHub теперь ведётся исходниками в `docs/wiki/`:
  Home, Быстрый старт, Системные требования, Установка, Обновление и откат,
  Настройки в интерфейсе — каждая страница на английском и русском
  (суффикс `.ru`). Каждое утверждение на страницах находится в
  `docs/myrmidon/` и `scripts/myrmidon/deploy/`.
- Workflow `myrmidon-wiki-sync` публикует `docs/wiki/` в репозиторий вики
  при каждом пуше в `main`, затрагивающем `docs/wiki/**`, и на каждом
  опубликованном выпуске, после чего пробует каждую страницу по HTTP:
  ответ не 200 валит прогон. Прогон аутентифицируется секретом
  `WIKI_SYNC_TOKEN` — классическим PAT со scope `repo` (fine-grained PAT
  репозиторий вики не покрывают). Первая страница вики создаётся руками на
  GitHub: до этого репозитория вики не существует.
