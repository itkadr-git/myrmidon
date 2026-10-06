---
divergence-section: 1.6 — эксплуатация и релизный цикл
---

## changelog-en

### Release tags get their own un-cancellable CI; the publish gate reads it (1.6.5 TAG-CI)

- The 1.6.4 incident: the tag was pushed, bots merged four PRs into `main` a
  minute later, and the shared concurrency group of `myrmidon-ci.yml`
  (`cancel-in-progress: true`) cancelled the CI run of the tag's commit — the
  automatic publish refused, the tag CI and the release were re-run by hand.
- New workflow **Myrmidon CI (tag)** (`.github/workflows/myrmidon-ci-tag.yml`):
  the full CI tier on every `myr-vX.Y.Z` tag push (including `-rc.N`) and via
  `workflow_dispatch` with a mandatory `tag` input. Own concurrency group
  `myrmidon-ci-tag-<tag>` with `cancel-in-progress: false` — a push to `main`
  can no longer cancel it.
- The publish gate (`publish-github-release.sh`) now waits for the tag's own
  CI run only (`head_branch == tag`): a green main run of the same commit no
  longer satisfies the gate, and a cancelled tag run refuses the publish
  loudly with the recovery path (instead of timing out).
- The release tag pattern accepts `-rc.N` tags end to end (gate, tag CI,
  publish workflow trigger).

## changelog-ru

### У тега релиза — свой неотменяемый CI; гейт публикации читает его (1.6.5 TAG-CI)

- Инцидент 1.6.4: тег поставлен, через минуту боты смержили четыре PR в
  `main`, и общая concurrency-группа `myrmidon-ci.yml`
  (`cancel-in-progress: true`) отменила прогон CI коммита тега —
  автопубликация отказала, CI тега и релиз перезапускали руками.
- Новый workflow **Myrmidon CI (tag)** (`.github/workflows/myrmidon-ci-tag.yml`):
  полный уровень CI на каждый пуш тега `myr-vX.Y.Z` (включая `-rc.N`) и вручную
  (`workflow_dispatch` с обязательным `tag`). Своя concurrency-группа
  `myrmidon-ci-tag-<тег>` с `cancel-in-progress: false` — пуш в `main` его
  больше не отменяет.
- Гейт публикации (`publish-github-release.sh`) ждёт только прогон самого
  тега (`head_branch == тег`): зелёный прогон того же коммита на `main` гейт
  больше не удовлетворяет, а отменённый прогон тега отказывает публикации с
  явным сообщением и путём восстановления (вместо ожидания до таймаута).
- Паттерн релизного тега принимает `-rc.N` насквозь (гейт, CI тега, триггер
  публикации).
