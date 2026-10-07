---
divergence-section: Трек 1 — платформа
---

## changelog-en

### Release-freeze gate accepts the tag's own CI run (FREEZE-CI-TAG)

- The `freeze` PR gate and the freeze state (`release-freeze.sh`) now accept
  a green `Myrmidon CI (tag)` run (`myrmidon-ci-tag.yml`) on the tag's commit
  as the release CI — the same run the publish gate
  (`publish-github-release.sh`) waits on. Before, the gate only counted a
  `myrmidon-ci.yml` run on the tag commit (which exists only while `main`
  still sits exactly on the tag commit), so a tag cut from behind `main`
  froze every PR with no path to a green gate.
- A red tag CI remains a broken release, not a freeze (unchanged).

## changelog-ru

### Гейт заморозки выпуска принимает собственный CI-прогон тега (FREEZE-CI-TAG)

- Проверка PR `freeze` и состояние заморозки (`release-freeze.sh`) теперь
  принимают зелёный прогон `Myrmidon CI (tag)` (`myrmidon-ci-tag.yml`) на
  коммите тега как CI выпуска — тот самый прогон, которого ждёт гейт
  публикации (`publish-github-release.sh`). Раньше гейт считал только прогон
  `myrmidon-ci.yml` на коммите тега (он существует, лишь пока `main` стоит
  ровно на коммите тега), поэтому тег, срезанный позади `main`, замораживал
  все PR без пути к зелёному гейту.
- Красный CI тега по-прежнему означает сломанный выпуск, а не заморозку.

## divergence

| FREEZE-CI-TAG | Гейт заморозки (`release-freeze.sh`, оба режима) принимает за CI тега и прогон `myrmidon-ci-tag.yml` на ветке тега — раньше только `myrmidon-ci.yml` (на ветке тега или main того же коммита) | `scripts/myrmidon/release/release-freeze.sh` (выбор прогонов в `tag_ci_verdict`) + тесты `release-freeze.test.mjs` | Гейт публикации (`publish-github-release.sh`) уже ждёт именно `Myrmidon CI (tag)`; у `myrmidon-ci.yml` нет тег-триггера, поэтому тег без main-прогона на том же sha держал заморозку навечно (инцидент 07.10: rc.6 с зелёным ci-tag заморозил весь флот PR) | `scripts/myrmidon/release/release-freeze.test.mjs` (принимает зелёный ci-tag на теге; игнорирует ci-tag на main; set-state закрывает задачу заморозки по зелёному ci-tag) | Никогда, наше поведение — согласование с гейтом публикации | (этот PR) |
