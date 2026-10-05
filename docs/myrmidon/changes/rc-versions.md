## changelog-en

### Release candidates and the `latest` marker only after the production proof (RC-VERSIONS)

- Releases now go through a trial run: the tag `myr-vX.Y.Z-rc.N` builds every
  component image as `X.Y.Z-rc.N` (the version `/api/health` reports), and the
  release publish goes out as a GitHub **pre-release** `Myrmidon X.Y.Z-rc.N
  (RC N)` with the base version's changelog notes and its own digest manifest.
  `deploy.sh --release myr-vX.Y.Z-rc.N` works like any release; the CI-image
  gate (deploy scripts and the board's deploy/canary checks) accepts the rc
  tag as release proof.
- A publish — rc or final — NEVER moves the GitHub `latest` marker:
  `publish-github-release.sh` no longer passes `--latest`. An rc supersedes
  nothing, and a final tag never supersedes its own release candidates.
- The marker moves only by the explicit step
  `scripts/myrmidon/release/promote-latest.sh --tag myr-vX.Y.Z`: it refuses an
  rc tag, a pre-release, a release commit not on `main`, and — the point of
  the requirement — any case where our production board's `/api/health`
  reports a version other than `X.Y.Z`. The board address comes from
  `--health-url` / `MYRMIDON_PROD_HEALTH_URL` (fallback `HEALTH_URL`) and, in
  `authenticated` mode, `--health-token-file` / `MYRMIDON_PROD_HEALTH_TOKEN_FILE`
  (fallback `HEALTH_TOKEN_FILE`). The full flow: rc → deploy to our
  production → verify (health, attention list, fleet taking tasks, bot
  images) → final tag `myr-vX.Y.Z` on the SAME commit → promote to Latest.
  See [deploy.md](deploy.md), "Release candidates and the `latest` marker".

## changelog-ru

### Кандидаты выпуска: метка `latest` — только после проверки на бое (RC-VERSIONS)

- Выпуск теперь проходит пробный прогон: тег `myr-vX.Y.Z-rc.N` собирает все
  образы компонентов как `X.Y.Z-rc.N` (эту версию показывает `/api/health`), а
  публикация уходит GitHub **pre-release** `Myrmidon X.Y.Z-rc.N (RC N)` с
  заметками базовой версии и своим манифестом digest'ов.
  `deploy.sh --release myr-vX.Y.Z-rc.N` работает как обычный выпуск; гейт
  CI-образов (скрипты выката и проверки доски deploy/canary) принимает тег
  кандидата как доказательство выпуска.
- Публикация — кандидатская или финальная — НИКОГДА не двигает метку `latest`:
  `publish-github-release.sh` больше не передаёт `--latest`. Кандидат ничего не
  вытесняет, а финальный тег не вытесняет собственных кандидатов.
- Метку двигает только явный шаг
  `scripts/myrmidon/release/promote-latest.sh --tag myr-vX.Y.Z`: он отказывает
  тегу-кандидату, pre-release, коммиту релиза вне `main` и — суть требования —
  любому случаю, когда `/api/health` нашей боевой доски отвечает версией не
  `X.Y.Z`. Адрес доски — `--health-url` / `MYRMIDON_PROD_HEALTH_URL` (запасной
  вариант `HEALTH_URL`), а в режиме `authenticated` — `--health-token-file` /
  `MYRMIDON_PROD_HEALTH_TOKEN_FILE` (запасной вариант `HEALTH_TOKEN_FILE`).
  Поток целиком: rc → выкат на наш бой → проверка (здоровье, список
  внимания, флот берёт задачи, образы ботов) → финальный тег `myr-vX.Y.Z` на
  ТОМ ЖЕ коммите → перевод в Latest. См. [deploy.ru.md](deploy.ru.md),
  «Кандидаты выпуска и метка `latest`».
